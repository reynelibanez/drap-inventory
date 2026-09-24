import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

// Permitir "varios valores" en un atributo que antes era de uno solo (p. ej. Tipo/Capacidad de disco), para poder
// cargar el mismo componente más de una vez en un equipo (dos discos duros, dos memorias...). Cubre: la migración
// de lo ya guardado (un id suelto pasa a ser una lista de un elemento, sin perder nada), las barreras (no se puede
// aplicar dos veces ni a un atributo que no es de un solo valor) y que la importación de lotes por CSV entiende una
// celda con varios discos ("256GB SSD, 1TB HDD") una vez habilitado.

let api: Api;
let tokA: string;
let m: ReturnType<typeof metaHelper>;
let laptopTypeId: number;

async function reloadMeta() {
  const meta = await api.call('GET', '/api/meta', tokA);
  m = metaHelper(meta.body);
  return meta.body;
}

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Refurb Multiselect', 'adminMulti');
  tokA = (await login(api, 'adminMulti')).token;
  await reloadMeta();
  laptopTypeId = m.type('laptop');
});
afterAll(() => stopApi(api));

describe('POST /api/attributes/:id/enable-multiple', () => {
  it('migra lo ya guardado (un id suelto pasa a lista de un elemento) sin perder nada', async () => {
    const meta = await reloadMeta();
    const storageTypeAttr = meta.attributes.find((a: any) => a.key === 'storage_type');
    expect(storageTypeAttr.dataType).toBe('select');

    const ssdId = m.item('storage_type', 'SSD SATA');
    const lot = await api.call('POST', '/api/lots', tokA, { lines: [] });
    expect(lot.status).toBe(200);
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokA, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, tokA, {
      equipmentTypeId: laptopTypeId, specs: { storage_type: ssdId }, serialNumber: 'MS-001',
    });
    expect(u.status).toBe(200);
    expect(u.body.specs.storage_type).toBe(ssdId); // todavía de un solo valor

    const en = await api.call('POST', `/api/attributes/${storageTypeAttr.id}/enable-multiple`, tokA, {});
    expect(en.status).toBe(200);

    const metaAfter = await reloadMeta();
    expect(metaAfter.attributes.find((a: any) => a.key === 'storage_type').dataType).toBe('multiselect');

    const after = await api.call('GET', `/api/units/${u.body.id}`, tokA);
    expect(after.body.specs.storage_type).toEqual([ssdId]); // migrado a lista de un elemento, mismo valor
  });

  it('no se puede aplicar dos veces, ni a un atributo que no es de un solo valor', async () => {
    const meta = await reloadMeta();
    const storageTypeAttr = meta.attributes.find((a: any) => a.key === 'storage_type');
    expect(storageTypeAttr.dataType).toBe('multiselect'); // ya se habilitó en el test anterior
    const again = await api.call('POST', `/api/attributes/${storageTypeAttr.id}/enable-multiple`, tokA, {});
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('not_a_single_value_attribute');

    const textAttr = await api.call('POST', '/api/attributes', tokA, { key: 'nota_ms', label: { es: 'Nota', en: 'Note' }, dataType: 'text' });
    expect(textAttr.status).toBe(200);
    const onText = await api.call('POST', `/api/attributes/${textAttr.body.id}/enable-multiple`, tokA, {});
    expect(onText.status).toBe(400);
    expect(onText.body.error.code).toBe('not_a_single_value_attribute');
  });
});

describe('/api/imports: un equipo con más de un disco, una vez habilitado "varios valores"', () => {
  it('separa "256GB SSD, 1TB HDD" en dos discos, tipo y capacidad emparejados por orden', async () => {
    const meta = await reloadMeta();
    const storageSizeAttr = meta.attributes.find((a: any) => a.key === 'storage_size');
    // "Tipo de disco" ya quedó en "varios valores" por el test anterior; falta habilitar "Capacidad de disco".
    const en = await api.call('POST', `/api/attributes/${storageSizeAttr.id}/enable-multiple`, tokA, {});
    expect(en.status).toBe(200);
    await reloadMeta();

    const header = 'SERIAL,MARCA,MODELO,DISCO';
    const row = 'MS-DUAL-1,HP,15-BA009DX,"256GB SSD, 1TB HDD"';
    const csv = [header, row].join('\n');
    const mapping = { serialCol: 0, referenceCol: null, notesCol: null, extraCols: [], attrs: { brand: 1, model: 2, storage_type: 3, storage_size: 3 } };

    const r = await api.call('POST', '/api/imports/commit', tokA, { equipmentTypeId: laptopTypeId, csv, mapping, lotReference: 'Prueba dos discos' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    await reloadMeta(); // la importación pudo haber creado valores de catálogo nuevos (p. ej. "1TB")

    const bySerial = await api.call('GET', '/api/units/lookup?code=MS-DUAL-1', tokA);
    expect(bySerial.status).toBe(200);
    const unit = await api.call('GET', `/api/units/${bySerial.body.id}`, tokA);
    expect(unit.body.specs.storage_type).toEqual([m.item('storage_type', 'SSD SATA'), m.item('storage_type', 'HDD')]);
    expect(unit.body.specs.storage_size).toEqual([m.item('storage_size', '256'), m.item('storage_size', '1TB')]);
  });

  it('permite repetir el mismo valor (dos discos del mismo tamaño), sin colapsarlos en uno solo', async () => {
    const header = 'SERIAL,MARCA,MODELO,DISCO';
    const row = 'MS-DUAL-2,HP,15-BA009DX,"256GB SSD, 256GB SSD"';
    const csv = [header, row].join('\n');
    const mapping = { serialCol: 0, referenceCol: null, notesCol: null, extraCols: [], attrs: { brand: 1, model: 2, storage_type: 3, storage_size: 3 } };

    const r = await api.call('POST', '/api/imports/commit', tokA, { equipmentTypeId: laptopTypeId, csv, mapping, lotReference: 'Prueba dos discos iguales' });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);

    const bySerial = await api.call('GET', '/api/units/lookup?code=MS-DUAL-2', tokA);
    const unit = await api.call('GET', `/api/units/${bySerial.body.id}`, tokA);
    const ssdId = m.item('storage_type', 'SSD SATA');
    const size256Id = m.item('storage_size', '256');
    expect(unit.body.specs.storage_type).toEqual([ssdId, ssdId]);
    expect(unit.body.specs.storage_size).toEqual([size256Id, size256Id]);
  });
});

describe('registrar un equipo a mano con el mismo valor repetido más de una vez', () => {
  it('guarda los dos valores (no los junta en uno) al crear el equipo', async () => {
    const meta = await reloadMeta();
    const ssdId = m.item('storage_type', 'SSD SATA');
    const lot = await api.call('POST', '/api/lots', tokA, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokA, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, tokA, {
      equipmentTypeId: laptopTypeId, specs: { storage_type: [ssdId, ssdId] }, serialNumber: 'MS-DUAL-3',
    });
    expect(u.status).toBe(200);
    expect(u.body.specs.storage_type).toEqual([ssdId, ssdId]);
  });
});
