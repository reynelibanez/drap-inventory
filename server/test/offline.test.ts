import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db.js';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

/** Soporte del trabajo sin conexión: llaves de idempotencia, modelos nuevos aprendidos y borrado de lotes vacíos. */
describe('trabajo sin conexión (servidor)', () => {
  let api: Api; let token: string; let companyId: number; let m: ReturnType<typeof metaHelper>; let meta: any;
  const count = (sql: string, p: unknown[] = []) => withTenant(companyId, async (db) => (await db.one<{ n: number }>(sql, p)).n);

  beforeAll(async () => {
    api = await startApi();
    const co = await makeCompany('Offline SA', 'admin_off');
    companyId = co.id;
    token = (await login(api, 'admin_off', 'password123', companyId)).token;
    meta = (await api.call('GET', '/api/meta', token)).body;
    m = metaHelper(meta);
  });
  afterAll(() => stopApi(api));

  it('una acción enviada dos veces con la misma llave se ejecuta una sola vez', async () => {
    const h = { 'idempotency-key': 'test-lot-key-0001' };
    const a = await api.call('POST', '/api/lots', token, { lines: [], reference: 'OFF-1' }, h);
    const b = await api.call('POST', '/api/lots', token, { lines: [], reference: 'OFF-1' }, h);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(await count(`SELECT count(*)::int AS n FROM lots WHERE reference = 'OFF-1'`)).toBe(1);
    // otra llave sí crea otro lote
    const c = await api.call('POST', '/api/lots', token, { lines: [], reference: 'OFF-1' }, { 'idempotency-key': 'test-lot-key-0002' });
    expect(c.body.id).not.toBe(a.body.id);
  });

  it('la misma llave usada en otra ruta se rechaza', async () => {
    const h = { 'idempotency-key': 'test-lot-key-0001' };
    const r = await api.call('POST', '/api/suppliers', token, { name: 'X' }, h);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('idempotency_key_reused');
  });

  it('un envío que falla no deja la llave gastada: al corregir se puede reintentar', async () => {
    const h = { 'idempotency-key': 'test-unit-key-01' };
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    // el lote aún no está en testeo → error
    const bad = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: m.type('generic'), specs: { description: 'A' }, serialNumber: 'IDEM-1' }, h);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const ok = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: m.type('generic'), specs: { description: 'A' }, serialNumber: 'IDEM-1' }, h);
    expect(ok.status).toBe(200);
    const again = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: m.type('generic'), specs: { description: 'A' }, serialNumber: 'IDEM-1' }, h);
    expect(again.body.id).toBe(ok.body.id);
    expect(await count(`SELECT count(*)::int AS n FROM units WHERE serial_number = 'IDEM-1'`)).toBe(1);
  });

  it('envíos simultáneos con la misma llave crean un solo registro', async () => {
    const h = { 'idempotency-key': 'test-parallel-01' };
    const rs = await Promise.all(Array.from({ length: 5 }, () => api.call('POST', '/api/lots', token, { lines: [], reference: 'PAR-1' }, h)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM lots WHERE reference = 'PAR-1'`)).toBe(1);
  });

  it('un modelo nuevo se agrega a la lista de su tipo, bajo su marca, y reenviarlo sin conexión no lo duplica', async () => {
    const laptop = meta.equipmentTypes.find((t: any) => t.key === 'laptop');
    const modelCat = meta.catalogs.find((c: any) => c.key === 'model_laptop');
    const dell = m.item('brand', 'Dell'); const hp = m.item('brand', 'HP');
    const add = (name: string, parent: number, key?: string) => api.call('POST', `/api/catalogs/${modelCat.id}/quick-item`, token, { name, parentItemId: parent }, key ? { 'idempotency-key': key } : undefined);
    const a = await add('Zeta Book 900', dell, 'quick-model-key-0001');
    const b = await add('  zeta   book 900 ', dell, 'quick-model-key-0002');   // el mismo modelo escrito distinto (otro reintento)
    const c = await add('Zeta Book 900', hp);                       // otra marca: es otro registro
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect(c.body.id).not.toBe(a.body.id);
    const rows = await withTenant(companyId, (db) => db.rows<{ parent: number }>(
      `SELECT parent_item_id AS parent FROM catalog_items WHERE catalog_id = $1 AND lower(name->>'es') = 'zeta book 900' ORDER BY parent_item_id`, [modelCat.id]));
    expect(rows.map((r) => r.parent).sort()).toEqual([dell, hp].sort());
    // con la llave repetida devuelve lo mismo
    const again = await add('Zeta Book 900', dell, 'quick-model-key-0001');
    expect(again.body).toEqual(a.body);
    // y el equipo se guarda con el modelo elegido
    const lot = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, token, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, token, { equipmentTypeId: laptop.id, specs: { brand: dell, model: a.body.id }, serialNumber: 'LRN-1' });
    expect(u.status).toBe(200);
  });

  it('un lote se puede eliminar mientras no esté cerrado (con equipos incluidos); cerrado, o con equipos vendidos, no', async () => {
    const generic = m.type('generic');

    // vacío: se puede eliminar
    const empty = await api.call('POST', '/api/lots', token, { lines: [{ equipmentTypeId: generic, specs: { description: 'Lote de prueba' }, expectedQty: 3 }] });
    const d0 = await api.call('GET', `/api/lots/${empty.body.id}`, token);
    expect(d0.body.deletable).toBe(true);
    const list = await api.call('GET', '/api/lots?pageSize=200', token);
    expect(list.body.items.find((l: any) => l.id === empty.body.id).deletable).toBe(true);
    const okEmpty = await api.call('DELETE', `/api/lots/${empty.body.id}`, token);
    expect(okEmpty.status).toBe(200);
    expect((await api.call('GET', `/api/lots/${empty.body.id}`, token)).status).toBe(404);

    // con un conteo guardado (todavía sin equipos): ya no bloquea, solo estar cerrado lo hace
    const counted = await api.call('POST', '/api/lots', token, { lines: [{ equipmentTypeId: generic, specs: { description: 'Lote de prueba' }, expectedQty: 2 }] });
    const line = (await api.call('GET', `/api/lots/${counted.body.id}`, token)).body.lines[0];
    await api.call('PUT', `/api/lots/${counted.body.id}/counts`, token, { counts: [{ lineId: line.id, countedQty: 2 }] });
    expect((await api.call('GET', `/api/lots/${counted.body.id}`, token)).body.deletable).toBe(true);
    const delCounted = await api.call('DELETE', `/api/lots/${counted.body.id}`, token);
    expect(delCounted.status).toBe(200);

    // con un equipo (no vendido): se elimina el lote y el equipo con él
    const withUnit = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${withUnit.body.id}/transition`, token, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${withUnit.body.id}/units`, token, { equipmentTypeId: generic, specs: { description: 'x' }, serialNumber: 'DEL-1' });
    const del2 = await api.call('DELETE', `/api/lots/${withUnit.body.id}`, token);
    expect(del2.status).toBe(200);
    expect((await api.call('GET', `/api/units/${u.body.id}`, token)).status).toBe(404);

    // con un equipo YA VENDIDO: se rechaza y no se toca nada
    const soldLot = await api.call('POST', '/api/lots', token, {
      requiresTesting: false,
      lines: [{ equipmentTypeId: generic, specs: { description: 'y' }, expectedQty: 1 }],
    });
    const soldLineId = (await api.call('GET', `/api/lots/${soldLot.body.id}`, token)).body.lines[0].id;
    await api.call('PUT', `/api/lots/${soldLot.body.id}/counts`, token, { counts: [{ lineId: soldLineId, countedQty: 1 }] });
    await api.call('POST', `/api/lots/${soldLot.body.id}/transition`, token, { action: 'finish_count' });
    const su = await api.call('POST', `/api/lots/${soldLot.body.id}/units`, token,
      { equipmentTypeId: generic, specs: { description: 'y' }, serialNumber: 'DEL-SOLD-1', skipTest: true });
    expect(su.status).toBe(200);
    const sale = await api.call('POST', '/api/quick-sales', token, { unitIds: [su.body.id] });
    expect(sale.status).toBe(200);
    const delSold = await api.call('DELETE', `/api/lots/${soldLot.body.id}`, token);
    expect(delSold.status).toBe(409);
    expect(delSold.body.error.code).toBe('lot_has_sold_units');
    expect((await api.call('GET', `/api/lots/${soldLot.body.id}`, token)).status).toBe(200);
    expect((await api.call('GET', `/api/units/${su.body.id}`, token)).status).toBe(200);

    // cerrado: no se puede eliminar aunque no tenga equipos
    const closable = await api.call('POST', '/api/lots', token, { lines: [] });
    await api.call('POST', `/api/lots/${closable.body.id}/transition`, token, { action: 'start_testing' });
    await api.call('POST', `/api/lots/${closable.body.id}/transition`, token, { action: 'close' });
    const delClosed = await api.call('DELETE', `/api/lots/${closable.body.id}`, token);
    expect(delClosed.status).toBe(409);
    expect(delClosed.body.error.code).toBe('lot_closed');
    expect((await api.call('GET', `/api/lots/${closable.body.id}`, token)).body.deletable).toBe(false);
  });
});
