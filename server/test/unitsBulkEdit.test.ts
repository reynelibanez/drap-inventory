import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let tok: string;
let m: ReturnType<typeof metaHelper>;
let lotId: number;
let laptopTypeId: number, desktopTypeId: number;

async function makeUnit(equipmentTypeId: number, specs: Record<string, unknown>, serial: string) {
  const r = await api.call('POST', `/api/lots/${lotId}/units`, tok, { equipmentTypeId, specs, serialNumber: serial, skipTest: true });
  expect(r.status).toBe(200);
  return r.body as any;
}

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Refurb Bulk Edit', 'adminBulkEdit');
  tok = (await login(api, 'adminBulkEdit')).token;
  const meta = await api.call('GET', '/api/meta', tok);
  m = metaHelper(meta.body);
  laptopTypeId = m.type('laptop');
  desktopTypeId = m.type('desktop');
  await m.ensureModels(api, tok, [['laptop', 'Dell', 'Latitude 7490'], ['desktop', 'HP', 'ProDesk 600']]);

  const lot = await api.call('POST', '/api/lots', tok, {
    requiresTesting: false,
    lines: [
      { equipmentTypeId: laptopTypeId, specs: { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, expectedQty: 20 },
      { equipmentTypeId: desktopTypeId, specs: { brand: m.item('brand', 'HP'), model: m.model('desktop', 'HP', 'ProDesk 600') }, expectedQty: 5 },
    ],
  });
  expect(lot.status).toBe(200);
  lotId = lot.body.id;
  const det = await api.call('GET', `/api/lots/${lotId}`, tok);
  const counts = det.body.lines.map((l: { id: number; expectedQty: number }) => ({ lineId: l.id, countedQty: l.expectedQty }));
  await api.call('PUT', `/api/lots/${lotId}/counts`, tok, { counts });
  const finish = await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'finish_count' });
  expect(finish.status).toBe(200);
  expect(finish.body.statusKey).toBe('counted');
});
afterAll(() => stopApi(api));

describe('/api/units/bulk-edit: cambiar los mismos datos en varios equipos a la vez', () => {
  it('sin sesión, se rechaza', async () => {
    const r = await api.call('POST', '/api/units/bulk-edit', null, { unitIds: [1], notes: 'x' });
    expect(r.status).toBe(401);
  });

  it('sin ningún dato para cambiar, se rechaza', async () => {
    const u = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, 'BULK-EMPTY');
    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [u.id] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('nothing_to_change');
  });

  it('cambia una especificación igual en varios equipos del mismo tipo, sin tocar el resto de sus datos', async () => {
    const u1 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '8') }, 'BULK-L1');
    const u2 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '16') }, 'BULK-L2');
    const ram32 = m.item('ram_size', '32');

    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [u1.id, u2.id], specs: { ram: ram32 } });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);

    const d1 = await api.call('GET', `/api/units/${u1.id}`, tok);
    const d2 = await api.call('GET', `/api/units/${u2.id}`, tok);
    expect(d1.body.specs.ram).toBe(ram32);
    expect(d2.body.specs.ram).toBe(ram32);
    // La marca y el modelo, que no se tocaron, siguen igual que antes.
    expect(d1.body.specs.brand).toBe(m.item('brand', 'Dell'));
    expect(d2.body.specs.model).toBe(m.model('laptop', 'Dell', 'Latitude 7490'));
  });

  it('un valor vacío borra ese dato en todos los seleccionados', async () => {
    const u1 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '8') }, 'BULK-CLR1');
    const u2 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '8') }, 'BULK-CLR2');
    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [u1.id, u2.id], specs: { ram: null } });
    expect(r.status).toBe(200);
    const d1 = await api.call('GET', `/api/units/${u1.id}`, tok);
    expect(d1.body.specs.ram).toBeUndefined();
  });

  it('cambia el grado funcional en equipos de tipos distintos a la vez (deja "no vendible" al que corresponda)', async () => {
    const laptop = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, 'BULK-MIX1');
    const desktop = await makeUnit(desktopTypeId, { brand: m.item('brand', 'HP'), model: m.model('desktop', 'HP', 'ProDesk 600') }, 'BULK-MIX2');
    expect(laptop.statusKey).toBe('available');
    expect(desktop.statusKey).toBe('available');

    const fMeta = (await api.call('GET', '/api/meta', tok)).body;
    const mm = metaHelper(fMeta);
    const functionalF = mm.item('functional_grade', 'No funciona');

    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [laptop.id, desktop.id], functionalGradeId: functionalF, notes: 'Revisado en lote' });
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);

    const d1 = await api.call('GET', `/api/units/${laptop.id}`, tok);
    const d2 = await api.call('GET', `/api/units/${desktop.id}`, tok);
    expect(d1.body.functionalGradeId).toBe(functionalF);
    expect(d2.body.functionalGradeId).toBe(functionalF);
    expect(d1.body.statusKey).toBe('not_sellable');
    expect(d2.body.statusKey).toBe('not_sellable');
    expect(d1.body.notes).toBe('Revisado en lote');
    expect(d2.body.notes).toBe('Revisado en lote');
  });

  it('si alguno de los seleccionados ya está vendido, no cambia nada (ni en ese ni en los demás)', async () => {
    const u1 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, 'BULK-SOLD1');
    const u2 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, 'BULK-SOLD2');

    const quickSale = await api.call('POST', '/api/quick-sales', tok, { unitIds: [u1.id] });
    expect(quickSale.status).toBe(200);
    const sold = await api.call('GET', `/api/units/${u1.id}`, tok);
    expect(sold.body.statusKey).toBe('sold');

    const before2 = await api.call('GET', `/api/units/${u2.id}`, tok);
    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [u1.id, u2.id], notes: 'no debería aplicarse' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('unit_sold');
    const after2 = await api.call('GET', `/api/units/${u2.id}`, tok);
    expect(after2.body.notes).toBe(before2.body.notes); // el equipo no vendido tampoco cambió
  });

  it('un id de equipo inexistente se rechaza sin cambiar los demás', async () => {
    const u1 = await makeUnit(laptopTypeId, { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490') }, 'BULK-MISSING');
    const r = await api.call('POST', '/api/units/bulk-edit', tok, { unitIds: [u1.id, 99999999], notes: 'x' });
    expect(r.status).toBe(404);
  });
});
