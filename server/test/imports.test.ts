import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';
import { withTenant } from '../src/db.js';
import { parseCsv } from '../src/services/csv.js';
import { parseCpu, parseStorage } from '../src/services/importer.js';
import { ensureImportPermission } from '../src/services/importDefaults.js';

let api: Api;
let tokA: string;
let m: ReturnType<typeof metaHelper>;
let laptopTypeId: number;

const HEADER = '9,TECH,SERIAL,MAKE,MODEL,CPU,RAM,SSD,SIZE,O/S,BATTERY,P.S.,TOUCH,STATUS,NOTES';
const ROWS = [
  'TCY001,LEE,SN0001,HP,15-BA009DX,I5-1005G1,8GB,256GB SSD,"15.6""",WIN 10 PRO,GOOD,65-90W,,,Trae rayón leve',
  'TCY002,LEE,SN0001,HP,15-BA018WM,I3-7100U,8GB,256GB,"15.6""",WIN 11 PRO,EXCELLENT,65-90W,,,', // serie repetida: se omite
  'TCY003,LEE,SN0003,Newbrandz,CoolBook X,AMD RYZEN 5 3500U,4GB,500GB HDD,"14""",Linux,Fair,,,,',
];
const CSV = [HEADER, ...ROWS].join('\n');

function mappingFor() {
  return {
    serialCol: 2, referenceCol: 0, notesCol: 14, extraCols: [1],
    attrs: {
      brand: 3, model: 4, processor: 5, generation: 5, ram: 6, storage_type: 7, storage_size: 7,
      screen_size: 8, os: 9, battery_condition: 10, touch_screen: 12,
    },
  };
}

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Refurb Import', 'adminImport');
  tokA = (await login(api, 'adminImport')).token;
  const meta = await api.call('GET', '/api/meta', tokA);
  m = metaHelper(meta.body);
  laptopTypeId = m.type('laptop');
});
afterAll(() => stopApi(api));

describe('parseCsv (RFC4180)', () => {
  it('entiende comillas escapadas y comas dentro de comillas', () => {
    const rows = parseCsv('a,b,"c""d",e\n1,2,"3,4",5\n');
    expect(rows).toEqual([['a', 'b', 'c"d', 'e'], ['1', '2', '3,4', '5']]);
  });
  it('ignora líneas totalmente vacías', () => {
    const rows = parseCsv('a,b\n\n1,2\n\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseCpu / parseStorage', () => {
  it('separa procesador Intel y su generación', () => {
    expect(parseCpu('I5-1005G1')).toEqual({ family: 'Intel Core i5', skuName: '1005G1' });
  });
  it('separa procesador AMD Ryzen y su SKU', () => {
    expect(parseCpu('AMD RYZEN 5 3500U')).toEqual({ family: 'AMD Ryzen 5', skuName: '3500U' });
  });
  it('deja procesadores no reconocibles como familia sin generación', () => {
    expect(parseCpu('AMD AG7310')).toEqual({ family: 'AMD AG7310', skuName: null });
  });
  it('interpreta tipo y capacidad de disco', () => {
    expect(parseStorage('256GB SSD')).toEqual({ typeName: 'SSD SATA', code: '256', label: '256 GB' });
    expect(parseStorage('500GB HDD')).toEqual({ typeName: 'HDD', code: '500', label: '500 GB' });
    expect(parseStorage('256GB')).toEqual({ typeName: 'SSD SATA', code: '256', label: '256 GB' }); // sin tipo: se asume SSD
  });
});

describe('/api/imports: inspeccionar, previsualizar y confirmar', () => {
  it('sin sesión, se rechaza', async () => {
    const r = await api.call('POST', '/api/imports/inspect', null, { csv: CSV });
    expect(r.status).toBe(401);
  });

  it('inspecciona el archivo y devuelve encabezados y una muestra', async () => {
    const r = await api.call('POST', '/api/imports/inspect', tokA, { csv: CSV });
    expect(r.status).toBe(200);
    expect(r.body.headers).toHaveLength(15);
    expect(r.body.rowCount).toBe(3);
    expect(r.body.sample).toHaveLength(3);
  });

  it('la vista previa no deja nada guardado', async () => {
    const before = await api.call('GET', '/api/lots?pageSize=200', tokA);
    const r = await api.call('POST', '/api/imports/preview', tokA, { equipmentTypeId: laptopTypeId, csv: CSV, mapping: mappingFor(), lotReference: 'Prueba import' });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(true);
    expect(r.body.created).toBe(2);
    expect(r.body.skipped).toBe(1);
    const after = await api.call('GET', '/api/lots?pageSize=200', tokA);
    expect(after.body.total).toBe(before.body.total); // no se creó ningún lote de verdad
  });

  it('confirma la importación: crea el lote y los equipos con los datos resueltos', async () => {
    const r = await api.call('POST', '/api/imports/commit', tokA, { equipmentTypeId: laptopTypeId, csv: CSV, mapping: mappingFor(), lotReference: 'Prueba import' });
    expect(r.status).toBe(200);
    expect(r.body.preview).toBe(false);
    expect(r.body.created).toBe(2);
    expect(r.body.skipped).toBe(1);
    expect(r.body.results).toHaveLength(3);

    const [row1, row2, row3] = r.body.results;
    expect(row1.ok).toBe(true);
    expect(row2.ok).toBe(false);
    expect(row2.reason).toBe('serial_duplicate');
    expect(row3.ok).toBe(true);

    const lot = await api.call('GET', `/api/lots/${r.body.lotId}`, tokA);
    expect(lot.body.reference).toBe('Prueba import');
    expect(lot.body.requiresTesting).toBe(false);
    expect(lot.body.statusKey).toBe('counted');

    const u1 = await api.call('GET', `/api/units?lotId=${r.body.lotId}&pageSize=20`, tokA);
    expect(u1.body.total).toBe(2);
    const unitHp = u1.body.items.find((u: any) => u.serialNumber === 'SN0001');
    expect(unitHp.statusKey).toBe('available');
    expect(unitHp.testedAt).toBeTruthy();
    expect(unitHp.notes).toContain('Ref: TCY001');
    expect(unitHp.notes).toContain('TECH: LEE');
    expect(unitHp.notes).toContain('Trae rayón leve');

    const meta2 = (await api.call('GET', '/api/meta', tokA)).body;
    const nameOf = (catalogKey: string, id: number) => meta2.catalogs.find((c: any) => c.key === catalogKey)?.items.find((i: any) => i.id === id)?.name.es;

    // Marca y modelo se resolvieron a valores de catálogo (HP ya existía).
    expect(nameOf('brand', unitHp.specs.brand)).toBe('HP');
    // Procesador + generación separados a partir de "I5-1005G1".
    expect(nameOf('processor', unitHp.specs.processor)).toBe('Intel Core i5');
    // RAM y disco exactos.
    expect(unitHp.specs.ram).toBeTruthy();
    // Sistema operativo: "WIN 10 PRO" se corrige a "Windows 10 Pro".
    expect(nameOf('os', unitHp.specs.os)).toBe('Windows 10 Pro');
    // Estado de batería: "GOOD" se resuelve al valor con nombre en inglés "Good" (es: "Bueno").
    expect(nameOf('battery_condition', unitHp.specs.battery_condition)).toBe('Bueno');
    // Columna TOUCH vacía: no se marca el atributo.
    expect(unitHp.specs.touch_screen).toBeUndefined();

    const unitNew = u1.body.items.find((u: any) => u.serialNumber === 'SN0003');
    expect(nameOf('brand', unitNew.specs.brand)).toBe('Newbrandz'); // marca nueva: se crea en el catálogo
    expect(nameOf('processor', unitNew.specs.processor)).toBe('AMD Ryzen 5');

    // La marca nueva y el modelo nuevo quedan reportados como valores agregados al catálogo.
    expect(r.body.newCatalogItems.some((x: any) => x.attrKey === 'brand' && x.value === 'Newbrandz')).toBe(true);
  });

  it('un archivo vacío se rechaza con un error claro', async () => {
    const r = await api.call('POST', '/api/imports/inspect', tokA, { csv: '   \n  \n' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('empty_csv');
  });

  it('modelos numéricos parecidos NO se confunden entre sí (p. ej. 5410 no se guarda como 5400)', async () => {
    const csv1 = [HEADER, 'REF01,LEE,SNMODELA,Dell,5400,I5-1005G1,8GB,256GB SSD,"14""",WIN 10 PRO,GOOD,,,,'].join('\n');
    const r1 = await api.call('POST', '/api/imports/commit', tokA, { equipmentTypeId: laptopTypeId, csv: csv1, mapping: mappingFor(), lotReference: 'Prueba modelo A' });
    expect(r1.status).toBe(200);
    expect(r1.body.created).toBe(1);

    const csv2 = [HEADER, 'REF02,LEE,SNMODELB,Dell,5410,I5-1005G1,8GB,256GB SSD,"14""",WIN 10 PRO,GOOD,,,,'].join('\n');
    const r2 = await api.call('POST', '/api/imports/commit', tokA, { equipmentTypeId: laptopTypeId, csv: csv2, mapping: mappingFor(), lotReference: 'Prueba modelo B' });
    expect(r2.status).toBe(200);
    expect(r2.body.created).toBe(1);
    // "5410" no existía en el catálogo (solo "5400"), así que debe reportarse como valor nuevo agregado.
    expect(r2.body.newCatalogItems.some((x: any) => x.attrKey === 'model' && x.value === '5410')).toBe(true);

    const u1 = await api.call('GET', '/api/units?pageSize=20', tokA);
    const unitA = u1.body.items.find((u: any) => u.serialNumber === 'SNMODELA');
    const unitB = u1.body.items.find((u: any) => u.serialNumber === 'SNMODELB');
    expect(unitA.specs.model).not.toBe(unitB.specs.model); // deben quedar en catálogos distintos

    const meta2 = (await api.call('GET', '/api/meta', tokA)).body;
    const nameOf = (catalogKey: string, id: number) => meta2.catalogs.find((c: any) => c.key === catalogKey)?.items.find((i: any) => i.id === id)?.name.es;
    expect(nameOf('model_laptop', unitA.specs.model)).toBe('5400');
    expect(nameOf('model_laptop', unitB.specs.model)).toBe('5410');
  });
});

describe('permiso "Importar equipos desde un archivo CSV" en empresas que ya existían', () => {
  it('un rol que administra usuarios pero al que le falta el permiso lo recibe una sola vez, sin duplicar ni tocar otros roles', async () => {
    const co = await makeCompany('Import Perm SA', 'adminImportPerm');
    let roleId!: number; let otherRoleId!: number;
    await withTenant(co.id, async (db) => {
      // Simula una empresa vieja: el rol "Administrador" (tiene users.manage) no tiene lots.import,
      // y un rol sin users.manage (Técnico) tampoco lo tiene — no debe recibirlo.
      roleId = (await db.one<{ id: number }>(`SELECT id FROM roles WHERE name = 'Administrador'`)).id;
      otherRoleId = (await db.one<{ id: number }>(`SELECT id FROM roles WHERE name = 'Técnico'`)).id;
      // Simula el estado en el que quedó una empresa vieja: el permiso ya existe en el catálogo, pero el rol
      // se creó antes de que existiera, así que nunca lo tuvo (companies nuevas nunca corren el backfill).
      await db.query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM permissions WHERE key = 'lots.import')`, [roleId]);
      const before = await db.opt('SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND p.key = $2', [roleId, 'lots.import']);
      expect(before).toBeNull();

      await ensureImportPermission(db, co.id);
      await ensureImportPermission(db, co.id); // repetir no falla ni duplica

      const after = await db.rows('SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND p.key = $2', [roleId, 'lots.import']);
      expect(after.length).toBe(1);
      const otherHas = await db.opt('SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 AND p.key = $2', [otherRoleId, 'lots.import']);
      expect(otherHas).toBeNull();
    });

    const token = (await login(api, 'adminImportPerm', 'password123', co.id)).token;
    const roles = (await api.call('GET', '/api/roles', token)).body.items;
    expect(roles.find((r: any) => r.id === roleId).permissions).toContain('lots.import');
  });
});
