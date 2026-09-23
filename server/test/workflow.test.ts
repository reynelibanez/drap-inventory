import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, withTenant } from '../src/db.js';
import { releaseExpiredReservations } from '../src/services/sweeper.js';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let A: { id: number }, B: { id: number };
let tokA: string, tokB: string;
let m: ReturnType<typeof metaHelper>;

const yymm = () => { const d = new Date(); return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

beforeAll(async () => {
  api = await startApi();
  A = await makeCompany('Acme Refurb', 'adminA');
  B = await makeCompany('Beta Tech', 'adminB', 'en');
  tokA = (await login(api, 'adminA')).token;
  tokB = (await login(api, 'adminB')).token;
  const meta = await api.call('GET', '/api/meta', tokA);
  m = metaHelper(meta.body);
  await m.ensureModels(api, tokA, [['laptop', 'Dell', 'Latitude 7490'], ['laptop', 'HP', 'EliteBook 840'], ['laptop', 'Dell', 'Latitude 5490']]);
});
afterAll(() => stopApi(api));

describe('flujo completo de una empresa', () => {
  let lotId: number, lotCode: string, lineDell: number, lineHp: number;
  let u1: number, u2: number, u3: number;

  it('sesión y metadatos', async () => {
    const me = await api.call('POST', '/api/auth/refresh', null);
    expect(me.status).toBe(401);
    const meta = await api.call('GET', '/api/meta', tokA);
    expect(meta.status).toBe(200);
    expect(meta.body.catalogs.length).toBeGreaterThan(10);
    expect(meta.body.equipmentTypes.map((t: any) => t.key)).toContain('generic');
    expect(meta.body.company.name).toBe('Acme Refurb');
  });

  it('crea un lote con líneas y valida atributos obligatorios', async () => {
    const bad = await api.call('POST', '/api/lots', tokA, {
      lines: [{ equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell') }, expectedQty: 5 }], // falta modelo
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('required_attribute');
    expect(bad.body.error.params.attribute).toBe('model');

    const sup = await api.call('POST', '/api/suppliers', tokA, { name: 'Proveedor Uno' });
    expect(sup.status).toBe(200);
    const r = await api.call('POST', '/api/lots', tokA, {
      supplierId: sup.body.id, reference: 'PO-123',
      lines: [
        { equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '16') }, expectedQty: 5 },
        { equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'HP'), model: m.model('laptop', 'HP', 'EliteBook 840') }, expectedQty: 3 },
      ],
    });
    expect(r.status).toBe(200);
    lotId = r.body.id; lotCode = r.body.code;
    expect(lotCode).toBe(`L${yymm()}01`);

    const det = await api.call('GET', `/api/lots/${lotId}`, tokA);
    expect(det.body.statusKey).toBe('open');
    lineDell = det.body.lines[0].id; lineHp = det.body.lines[1].id;
  });

  it('no permite testear antes de contar; conteo con diferencias y línea no esperada', async () => {
    const early = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('laptop') });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('lot_not_counted');

    const count = await api.call('PUT', `/api/lots/${lotId}/counts`, tokA, { counts: [{ lineId: lineDell, countedQty: 4 }] });
    expect(count.status).toBe(200);
    expect(count.body.statusKey).toBe('counting');

    const unfinished = await api.call('POST', `/api/lots/${lotId}/transition`, tokA, { action: 'finish_count' });
    expect(unfinished.status).toBe(409);
    expect(unfinished.body.error.code).toBe('lines_not_counted');

    await api.call('PUT', `/api/lots/${lotId}/counts`, tokA, { counts: [{ lineId: lineHp, countedQty: 3 }] });
    const extra = await api.call('POST', `/api/lots/${lotId}/unexpected-lines`, tokA, {
      equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG') }, countedQty: 2,
    });
    expect(extra.status).toBe(200);

    const done = await api.call('POST', `/api/lots/${lotId}/transition`, tokA, { action: 'finish_count' });
    expect(done.status).toBe(200);
    expect(done.body.statusKey).toBe('counted');
    expect(done.body.summary).toMatchObject({ expected: 8, counted: 9, missing: 1, surplus: 2 });
    expect(done.body.lines.find((l: any) => l.isUnexpected).expectedQty).toBe(0);
  });

  it('genera códigos lote+técnico+registro y auto-asocia la línea', async () => {
    const r1 = await api.call('POST', `/api/lots/${lotId}/units`, tokA, {
      equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '16') }, serialNumber: 'SN-001',
    });
    expect(r1.status).toBe(200);
    expect(r1.body.code).toBe(`${lotCode}-1t1`);
    expect(r1.body.statusKey).toBe('testing');
    expect(r1.body.lotLineId).toBe(lineDell);
    u1 = r1.body.id;

    const r2 = await api.call('POST', `/api/lots/${lotId}/units`, tokA, {
      equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'HP'), model: m.model('laptop', 'HP', 'EliteBook 840') }, serialNumber: 'SN-002',
    });
    expect(r2.body.code).toBe(`${lotCode}-1t2`);
    expect(r2.body.lotLineId).toBe(lineHp);
    u2 = r2.body.id;

    const lot = await api.call('GET', `/api/lots/${lotId}`, tokA);
    expect(lot.body.statusKey).toBe('testing'); // el primer equipo pasa el lote a testeo

    const dup = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('laptop'), serialNumber: 'sn-001' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('serial_duplicate');
  });

  it('termina el testeo: exige lo obligatorio y aplica reglas de grado', async () => {
    const incomplete = await api.call('POST', `/api/units/${u1}/finish-test`, tokA, {
      cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A'),
    });
    expect(incomplete.status).toBe(400);
    expect(incomplete.body.error.code).toBe('required_attribute'); // faltan procesador, disco...

    const ok = await api.call('POST', `/api/units/${u1}/finish-test`, tokA, {
      cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A'),
      specs: { processor: m.item('processor', 'Intel Core i7'), storage_size: m.item('storage_size', '512') },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.statusKey).toBe('available');
    expect(ok.body.testedAt).toBeTruthy();

    // Grado funcional F => no vendible
    const bad = await api.call('POST', `/api/units/${u2}/finish-test`, tokA, {
      cosmeticGradeId: m.item('cosmetic_grade', 'C'), functionalGradeId: m.item('functional_grade', 'F'),
      specs: { processor: m.item('processor', 'Intel Core i5'), ram: m.item('ram_size', '8'), storage_size: m.item('storage_size', '256') },
    });
    expect(bad.status).toBe(200);
    expect(bad.body.statusKey).toBe('not_sellable');

    const r3 = await api.call('POST', `/api/lots/${lotId}/units`, tokA, {
      equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude 7490'), ram: m.item('ram_size', '16') }, serialNumber: 'SN-003',
    });
    u3 = r3.body.id;
    await api.call('POST', `/api/units/${u3}/finish-test`, tokA, {
      cosmeticGradeId: m.item('cosmetic_grade', 'B'), functionalGradeId: m.item('functional_grade', 'A'),
      specs: { processor: m.item('processor', 'Intel Core i7'), storage_size: m.item('storage_size', '512') },
    });

    // Búsqueda por forma corta y por serie
    const short = await api.call('GET', '/api/units/lookup?code=1t3', tokA);
    expect(short.body.id).toBe(u3);
    expect((await api.call('GET', '/api/units/lookup?code=SN-002', tokA)).body.id).toBe(u2);
  });

  it('el lote no se cierra con equipos en testeo', async () => {
    const r4 = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG') }, serialNumber: 'MON-1' });
    const close = await api.call('POST', `/api/lots/${lotId}/transition`, tokA, { action: 'close' });
    expect(close.status).toBe(409);
    expect(close.body.error.code).toBe('units_in_testing');
    // limpiar: lo dejamos como no vendible para no afectar los demás pasos
    await api.call('POST', `/api/units/${r4.body.id}/status`, tokA, { statusId: m.sys('unit_status', 'not_sellable') });
  });

  it('los equipos fuera de las líneas se agrupan por tipo y características', async () => {
    const mk = (serial: string) => api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('generic'), specs: { description: 'Docking Dell' }, serialNumber: serial });
    const a = await mk('OFF-1'); const b = await mk('OFF-2');
    expect(a.body.lotLineId).toBeNull();
    const lot = await api.call('GET', `/api/lots/${lotId}`, tokA);
    const g = lot.body.offLines.find((x: any) => x.specs.description === 'Docking Dell');
    expect(g).toMatchObject({ equipmentTypeId: m.type('generic'), tested: 2, inTesting: 2 });
    for (const u of [a, b]) await api.call('DELETE', `/api/units/${u.body.id}`, tokA);
    const after = await api.call('GET', `/api/lots/${lotId}`, tokA);
    expect(after.body.offLines.find((x: any) => x.specs.description === 'Docking Dell')).toBeUndefined();
  });

  it('un borrador se puede eliminar; un equipo ya testeado también (mientras no se haya vendido)', async () => {
    const d = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG') }, serialNumber: 'MON-DRAFT' });
    expect(d.status).toBe(200);
    const del = await api.call('DELETE', `/api/units/${d.body.id}`, tokA);
    expect(del.status).toBe(200);
    expect((await api.call('GET', `/api/units/${d.body.id}`, tokA)).status).toBe(404);
    // el número de serie queda libre para volver a registrarlo
    const again = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG') }, serialNumber: 'MON-DRAFT' });
    expect(again.status).toBe(200);
    await api.call('DELETE', `/api/units/${again.body.id}`, tokA);
    // un equipo ya testeado también se puede modificar y eliminar (no vendido)
    const t = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('generic'), specs: { description: 'Cable viejo' }, serialNumber: 'DEL-TESTED' });
    await api.call('POST', `/api/units/${t.body.id}/finish-test`, tokA, { cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A') });
    const mod = await api.call('PATCH', `/api/units/${t.body.id}`, tokA, { specs: { description: 'Cable nuevo' } });
    expect(mod.status).toBe(200);
    const hist = (await api.call('GET', `/api/units/${t.body.id}`, tokA)).body.history.find((h: any) => h.action === 'unit.updated');
    expect(hist.data.specs).toEqual({ description: ['Cable viejo', 'Cable nuevo'] });
    const delTested = await api.call('DELETE', `/api/units/${t.body.id}`, tokA);
    expect(delTested.status).toBe(200);
    expect((await api.call('GET', `/api/units/${t.body.id}`, tokA)).status).toBe(404);
  });

  describe('ubicaciones', () => {
    let rackId: number, slots: any[];
    it('crea almacén, área y rack con niveles personalizados', async () => {
      const wh = await api.call('POST', '/api/warehouses', tokA, { code: 'ALM1', name: 'Almacén principal' });
      const area = await api.call('POST', '/api/areas', tokA, { warehouseId: wh.body.id, code: 'A', name: 'Laptops', preferredTypeIds: [m.type('laptop')] });
      const rack = await api.call('POST', '/api/racks', tokA, {
        areaId: area.body.id, code: 'R01', layout: { levels: [{ slots: 2, capacity: 2 }, { slots: 3, capacity: 10 }] },
      });
      expect(rack.status).toBe(200);
      rackId = rack.body.id;
      const tree = await api.call('GET', '/api/locations/tree', tokA);
      const r = tree.body.warehouses[0].areas[0].racks[0];
      expect(r.capacity).toBe(2 * 2 + 3 * 10);
      expect(r.levels.map((l: any) => l.slots.length)).toEqual([2, 3]);
      slots = (await api.call('GET', '/api/locations/slots', tokA)).body.items;
      expect(slots.map((s: any) => s.code)).toContain('ALM1/A/R01/2-3');
    });

    it('sugiere agrupando equipos similares y respeta la capacidad', async () => {
      const s = await api.call('POST', '/api/locations/suggest', tokA, { unitIds: [u1, u3, u2] });
      expect(s.status).toBe(200);
      const byUnit = new Map(s.body.items.map((i: any) => [i.unitId, i]));
      // u1 y u3 son el mismo modelo → mismo espacio
      expect((byUnit.get(u1) as any).slotId).toBe((byUnit.get(u3) as any).slotId);
      expect((byUnit.get(u1) as any).slotId).not.toBeNull();

      const first = slots.find((x: any) => x.code.endsWith('/1-1'));
      const assign = await api.call('POST', '/api/locations/assign', tokA, {
        assignments: [{ unitId: u1, slotId: first.id }, { unitId: u3, slotId: first.id }],
      });
      expect(assign.status).toBe(200);
      const full = await api.call('POST', '/api/locations/assign', tokA, { assignments: [{ unitId: u2, slotId: first.id }] });
      expect(full.status).toBe(409);
      expect(full.body.error.code).toBe('slot_full');
    });

    it('prefiere el área marcada para ese tipo de equipo', async () => {
      const tree = await api.call('GET', '/api/locations/tree', tokA);
      const whId = tree.body.warehouses[0].id;
      const areaMon = await api.call('POST', '/api/areas', tokA, { warehouseId: whId, code: 'M', name: 'Monitores', preferredTypeIds: [m.type('monitor')] });
      await api.call('POST', '/api/racks', tokA, { areaId: areaMon.body.id, code: 'R01', layout: { levels: [{ slots: 2, capacity: 5 }] } });
      const mon = await api.call('POST', `/api/lots/${lotId}/units`, tokA, { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG') }, serialNumber: 'MON-PREF' });
      const s = await api.call('POST', '/api/locations/suggest', tokA, { unitIds: [mon.body.id] });
      expect(s.body.items[0].slotCode).toBe('ALM1/M/R01/1-1');
      expect(s.body.items[0].reason).toBe('empty_preferred');
      await api.call('POST', `/api/units/${mon.body.id}/status`, tokA, { statusId: m.sys('unit_status', 'not_sellable') });
    });

    it('no permite reducir capacidad por debajo de lo ocupado ni quitar espacios con equipos', async () => {
      const first = slots.find((x: any) => x.code.endsWith('/1-1'));
      const p = await api.call('PATCH', `/api/slots/${first.id}`, tokA, { capacity: 1 });
      expect(p.status).toBe(409);
      const l = await api.call('PUT', `/api/racks/${rackId}/layout`, tokA, { levels: [{ slots: 1, capacity: 2 }] }); // quita 1-1? no: 1-1 se queda; 1-2 y nivel 2 vacíos
      expect(l.status).toBe(200);
      const l2 = await api.call('PUT', `/api/racks/${rackId}/layout`, tokA, { levels: [{ slots: 2, capacity: 2 }, { slots: 3, capacity: 10 }] });
      expect(l2.status).toBe(200);
    });
  });

  describe('ventas', () => {
    let orderId: number, customerId: number;
    it('reserva equipos, evita doble reserva y completa la venta', async () => {
      const cu = await api.call('POST', '/api/customers', tokA, { name: 'Importadora Caribe', country: 'Cuba' });
      customerId = cu.body.id;
      const se = await api.call('POST', '/api/sellers', tokA, { name: 'Vendedor Uno' });
      const o = await api.call('POST', '/api/orders', tokA, { customerId, sellerId: se.body.id, lines: [{ equipmentTypeId: m.type('laptop'), quantity: 5 }] });
      expect(o.status).toBe(200);
      expect(o.body.code).toBe(`V${yymm()}-0001`);
      orderId = o.body.id;

      const notAvail = await api.call('POST', `/api/orders/${orderId}/items`, tokA, { unitIds: [u2] }); // no vendible
      expect(notAvail.status).toBe(409);
      expect(notAvail.body.error.code).toBe('unit_not_available');

      const add = await api.call('POST', `/api/orders/${orderId}/items`, tokA, { unitIds: [u1], unitPrice: 150 });
      expect(add.status).toBe(200);
      expect((await api.call('GET', `/api/units/${u1}`, tokA)).body.statusKey).toBe('reserved');

      const o2 = await api.call('POST', '/api/orders', tokA, { customerId, lines: [{ equipmentTypeId: m.type('laptop'), quantity: 5 }] });
      const dbl = await api.call('POST', `/api/orders/${o2.body.id}/items`, tokA, { unitIds: [u1] });
      expect(dbl.status).toBe(409);

      // "agrega 1 como estos" elige el disponible que queda (u3)
      const auto = await api.call('POST', `/api/orders/${orderId}/items/auto`, tokA, {
        typeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell') }, quantity: 1, unitPrice: 175,
      });
      expect(auto.status).toBe(200);
      expect(auto.body.itemCount).toBe(2);
      expect(auto.body.total).toBe(325);
      const tooMany = await api.call('POST', `/api/orders/${orderId}/items/auto`, tokA, { typeId: m.type('laptop'), quantity: 5 });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.error.code).toBe('not_enough_units');
      await api.call('POST', `/api/orders/${o2.body.id}/cancel`, tokA);

      const pdf = await api.call('GET', `/api/orders/${orderId}/packing-list.pdf?lang=en`, tokA);
      expect(pdf.status).toBe(200);
      expect(pdf.raw.subarray(0, 4).toString()).toBe('%PDF');
      const labels = await api.call('GET', `/api/units/labels.pdf?ids=${u1},${u3}`, tokA);
      expect(labels.raw.subarray(0, 4).toString()).toBe('%PDF');

      const done = await api.call('POST', `/api/orders/${orderId}/complete`, tokA);
      expect(done.status).toBe(200);
      expect(done.body.statusKey).toBe('completed');
      for (const id of [u1, u3]) expect((await api.call('GET', `/api/units/${id}`, tokA)).body.statusKey).toBe('sold');
      const edit = await api.call('PATCH', `/api/units/${u1}`, tokA, { notes: 'x' });
      expect(edit.status).toBe(409);
      // un equipo vendido no se puede eliminar
      const delSold = await api.call('DELETE', `/api/units/${u1}`, tokA);
      expect(delSold.status).toBe(409);
      expect(delSold.body.error.code).toBe('unit_sold');

      const hist = await api.call('GET', `/api/units/${u1}`, tokA);
      expect(hist.body.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['unit.created', 'unit.tested', 'unit.moved', 'unit.reserved', 'unit.sold']));
    });

    it('cancelar y vencer una reserva libera los equipos', async () => {
      // Se prepara un equipo disponible nuevo
      const r = await api.call('POST', `/api/lots/${lotId}/units`, tokA, {
        equipmentTypeId: m.type('generic'), specs: { description: 'Cable HDMI' }, serialNumber: 'GEN-1',
      });
      const uid = r.body.id;
      await api.call('POST', `/api/units/${uid}/finish-test`, tokA, { cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A') });
      const o = await api.call('POST', '/api/orders', tokA, { customerId, lines: [{ equipmentTypeId: m.type('generic'), quantity: 5 }] });
      await api.call('POST', `/api/orders/${o.body.id}/items`, tokA, { unitIds: [uid] });
      expect((await api.call('GET', `/api/units/${uid}`, tokA)).body.statusKey).toBe('reserved');
      await api.call('POST', `/api/orders/${o.body.id}/cancel`, tokA);
      expect((await api.call('GET', `/api/units/${uid}`, tokA)).body.statusKey).toBe('available');

      const o2 = await api.call('POST', '/api/orders', tokA, { customerId, lines: [{ equipmentTypeId: m.type('generic'), quantity: 5 }], reservedUntil: new Date(Date.now() + 3600_000).toISOString() });
      await api.call('POST', `/api/orders/${o2.body.id}/items`, tokA, { unitIds: [uid] });
      await withTenant(A.id, (db) => db.query(`UPDATE sales_orders SET reserved_until = now() - interval '1 minute' WHERE id = $1`, [o2.body.id]));
      const released = await releaseExpiredReservations({ error() {}, info() {} } as any);
      expect(released).toBe(1);
      expect((await api.call('GET', `/api/units/${uid}`, tokA)).body.statusKey).toBe('available');
      expect((await api.call('GET', `/api/orders/${o2.body.id}`, tokA)).body.statusKey).toBe('cancelled');
    });
  });
});

describe('concurrencia', () => {
  it('dos técnicos y peticiones simultáneas nunca repiten códigos', async () => {
    const lot = await api.call('POST', '/api/lots', tokA, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokA, { action: 'start_testing' });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      api.call('POST', `/api/lots/${lot.body.id}/units`, tokA, { equipmentTypeId: m.type('generic'), specs: { description: `x${i}` }, serialNumber: `CONC-${i}` })));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const codes = results.map((r) => r.body.code);
    expect(new Set(codes).size).toBe(12);
  });

  it('dos ventas a la vez sobre la misma unidad: solo una gana', async () => {
    const lot = await api.call('POST', '/api/lots', tokA, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tokA, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, tokA, { equipmentTypeId: m.type('generic'), specs: { description: 'Solo uno' }, serialNumber: 'RACE-1' });
    await api.call('POST', `/api/units/${u.body.id}/finish-test`, tokA, { cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A') });
    const cu = await api.call('POST', '/api/customers', tokA, { name: 'Carrera' });
    const [o1, o2] = await Promise.all([1, 2].map(() => api.call('POST', '/api/orders', tokA, { customerId: cu.body.id, lines: [{ equipmentTypeId: m.type('generic'), quantity: 5 }] })));
    const res = await Promise.all([o1, o2].map((o) => api.call('POST', `/api/orders/${o.body.id}/items`, tokA, { unitIds: [u.body.id] })));
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('permisos por función', () => {
  let memberId: number, tok: string;
  it('un usuario con rol Ventas no crea lotes; una excepción por usuario se lo permite', async () => {
    const roles = await api.call('GET', '/api/roles', tokA);
    const ventas = roles.body.items.find((r: any) => r.name === 'Ventas');
    const mem = await api.call('POST', '/api/team/members', tokA, {
      username: 'vendedor1', fullName: 'Vendedor Uno', password: 'password123', roleIds: [ventas.id],
    });
    expect(mem.status).toBe(200);
    memberId = mem.body.id;
    tok = (await login(api, 'vendedor1')).token;

    expect((await api.call('GET', '/api/orders', tok)).status).toBe(200);
    const denied = await api.call('POST', '/api/lots', tok, { lines: [] });
    expect(denied.status).toBe(403);
    expect(denied.body.error.params.permission).toBe('lots.create');

    await api.call('PUT', `/api/team/members/${memberId}`, tokA, {
      roleIds: [ventas.id], overrides: [{ permission: 'lots.create', effect: 'allow' }, { permission: 'sales.cancel', effect: 'deny' }],
    });
    const allowed = await api.call('POST', '/api/lots', tok, { lines: [] });
    expect(allowed.status).toBe(200);
    const cu = await api.call('POST', '/api/customers', tok, { name: 'Cliente V' });
    const o = await api.call('POST', '/api/orders', tok, { customerId: cu.body.id });
    expect((await api.call('POST', `/api/orders/${o.body.id}/cancel`, tok)).status).toBe(403); // negado aunque el rol lo tenga
  });

  it('crear un rol personalizado y asignarlo', async () => {
    const role = await api.call('POST', '/api/roles', tokA, { name: 'Solo conteo', permissions: ['lots.view', 'lots.count', 'catalogs.view'] });
    expect(role.status).toBe(200);
    const bad = await api.call('POST', '/api/roles', tokA, { name: 'Malo', permissions: ['no.existe'] });
    expect(bad.status).toBe(400);
  });

  it('el usuario ve los precios solo con sales.price', async () => {
    await api.call('PUT', `/api/team/members/${memberId}`, tokA, {
      roleIds: (await api.call('GET', '/api/roles', tokA)).body.items.filter((r: any) => r.name === 'Ventas').map((r: any) => r.id),
      overrides: [{ permission: 'sales.price', effect: 'deny' }],
    });
    const orders = await api.call('GET', '/api/orders', tok);
    expect(orders.body.items.every((o: any) => o.total === null)).toBe(true);
    const all = await api.call('GET', '/api/orders', tokA);
    expect(all.body.items.some((o: any) => o.total !== null)).toBe(true);
  });
});

describe('aislamiento entre empresas', () => {
  it('la empresa B no ve ni toca datos de A', async () => {
    const lots = await api.call('GET', '/api/lots', tokB);
    expect(lots.body.total).toBe(0);
    const units = await api.call('GET', '/api/units', tokB);
    expect(units.body.total).toBe(0);
    const someLot = (await api.call('GET', '/api/lots', tokA)).body.items[0];
    expect((await api.call('GET', `/api/lots/${someLot.id}`, tokB)).status).toBe(404);
    expect((await api.call('POST', `/api/lots/${someLot.id}/units`, tokB, { equipmentTypeId: 1 })).status).toBe(404);
  });

  it('cada empresa tiene su propia numeración', async () => {
    const lot = await api.call('POST', '/api/lots', tokB, { lines: [] });
    expect(lot.body.code).toBe(`L${yymm()}01`);
  });

  it('PostgreSQL (RLS) bloquea aunque el código falle: filas ajenas invisibles y escritura cruzada rechazada', async () => {
    const seen = await withTenant(B.id, (db) => db.one<{ n: number }>('SELECT count(*)::int AS n FROM lots WHERE company_id = $1', [A.id]));
    expect(seen.n).toBe(0);
    const noCtx = await pool.query('SELECT count(*)::int AS n FROM lots');
    expect(noCtx.rows[0].n).toBe(0); // sin empresa activa no se ve nada
    await expect(withTenant(B.id, (db) => db.query(
      `INSERT INTO suppliers (company_id, name) VALUES ($1, 'intruso')`, [A.id]))).rejects.toThrow(/row-level security/);
  });

  it('un usuario en dos empresas cambia entre ellas con permisos distintos', async () => {
    // adminA se agrega a B como usuario limitado
    const roles = await api.call('GET', '/api/roles', tokB);
    const soloConsulta = roles.body.items.find((r: any) => r.name === 'Solo consulta');
    const add = await api.call('POST', '/api/team/members', tokB, { username: 'adminA', fullName: 'Admin A', roleIds: [soloConsulta.id] });
    expect(add.status).toBe(200);
    expect(add.body.createdUser).toBe(false);

    const s = await login(api, 'adminA');
    expect(s.session.companies).toHaveLength(2);
    expect(s.session.activeCompanyId).toBeNull();
    const inA = await login(api, 'adminA', 'password123', A.id);
    const inB = await login(api, 'adminA', 'password123', B.id);
    expect((await api.call('POST', '/api/lots', inA.token, { lines: [] })).status).toBe(200);
    expect((await api.call('POST', '/api/lots', inB.token, { lines: [] })).status).toBe(403);
    // Cada empresa tiene su número de técnico
    const meB = await api.call('GET', '/api/team/members', tokB);
    expect(meB.body.items.map((x: any) => x.techNumber).sort()).toEqual([1, 2]);
  });

  it('una empresa no puede tomar la cuenta de un usuario compartido', async () => {
    const members = await api.call('GET', '/api/team/members', tokB);
    const shared = members.body.items.find((x: any) => x.username === 'adminA');
    const r = await api.call('POST', `/api/team/members/${shared.id}/reset-password`, tokB, { password: 'hackeado123' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('user_in_other_companies');
  });
});

describe('catálogos configurables', () => {
  it('crea un grado nuevo, un tipo y un atributo sin tocar código', async () => {
    const cat = (await api.call('GET', '/api/meta', tokA)).body.catalogs.find((c: any) => c.key === 'cosmetic_grade');
    const item = await api.call('POST', `/api/catalogs/${cat.id}/items`, tokA, { code: 'A+', name: { es: 'Premium', en: 'Premium' }, color: '#00aa00' });
    expect(item.status).toBe(200);

    const attr = await api.call('POST', '/api/attributes', tokA, { key: 'has_webcam', label: { es: 'Webcam', en: 'Webcam' }, dataType: 'boolean' });
    expect(attr.status).toBe(200);
    const type = await api.call('POST', '/api/equipment-types', tokA, {
      key: 'tablet', name: { es: 'Tableta', en: 'Tablet' }, attributes: [{ attributeId: attr.body.id, inLotLine: true }],
    });
    expect(type.status).toBe(200);

    const inUse = await api.call('DELETE', `/api/catalog-items/${m.item('cosmetic_grade', 'A')}`, tokA);
    expect(inUse.status).toBe(409); // ya hay equipos con grado A
    const sys = await api.call('DELETE', `/api/catalog-items/${m.sys('unit_status', 'available')}`, tokA);
    expect(sys.status).toBe(400);
  });
});

describe('etiquetas', () => {
  let tplId: number;
  const layout = { elements: [
    { id: 'a', type: 'field', source: 'code', x: 2, y: 2, w: 30, h: 5, fontSize: 9, bold: true },
    { id: 'b', type: 'qr', source: 'code', x: 2, y: 8, w: 18, h: 18 },
  ] };

  it('cada empresa nace con una plantilla estándar predeterminada', async () => {
    const r = await api.call('GET', '/api/label-templates', tokA);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items[0].isDefault).toBe(true);
    expect(r.body.items[0].layout.elements.some((e: any) => e.type === 'qr')).toBe(true);
  });

  it('crea una plantilla, la asocia a un tipo (solo una por tipo) y la duplica', async () => {
    const laptop = m.type('laptop'), monitor = m.type('monitor');
    const a = await api.call('POST', '/api/label-templates', tokA, { name: 'Laptops 89x36', widthMm: 89, heightMm: 36, layout, typeIds: [laptop, monitor] });
    expect(a.status).toBe(200);
    tplId = a.body.id;
    expect(a.body.typeIds.sort()).toEqual([laptop, monitor].sort());
    expect(a.body.widthMm).toBe(89);

    // otra plantilla que reclama "laptop" se lo quita a la primera
    const b = await api.call('POST', '/api/label-templates', tokA, { name: 'Solo laptops', widthMm: 57, heightMm: 32, layout, typeIds: [laptop] });
    const list = (await api.call('GET', '/api/label-templates', tokA)).body.items;
    expect(list.find((t: any) => t.id === tplId).typeIds).toEqual([monitor]);
    expect(list.find((t: any) => t.id === b.body.id).typeIds).toEqual([laptop]);

    const copy = await api.call('POST', `/api/label-templates/${tplId}/duplicate`, tokA);
    expect(copy.body.name).toBe('Laptops 89x36 (copia)');
    expect(copy.body.typeIds).toEqual([]);
  });

  it('solo una predeterminada y valida el diseño', async () => {
    const r = await api.call('PUT', `/api/label-templates/${tplId}`, tokA, { name: 'Laptops 89x36', widthMm: 89, heightMm: 36, layout, isDefault: true, typeIds: [] });
    expect(r.status).toBe(200);
    const list = (await api.call('GET', '/api/label-templates', tokA)).body.items;
    expect(list.filter((t: any) => t.isDefault && t.kind === 'unit').map((t: any) => t.id)).toEqual([tplId]);

    const bad = await api.call('POST', '/api/label-templates', tokA, { name: 'x', widthMm: 5, heightMm: 32, layout });
    expect(bad.status).toBe(400);
    const badEl = await api.call('POST', '/api/label-templates', tokA, { name: 'x', widthMm: 50, heightMm: 32, layout: { elements: [{ id: 'z', type: 'foo', x: 0, y: 0, w: 1, h: 1 }] } });
    expect(badEl.status).toBe(400);
  });

  it('exige permiso para diseñar, pero cualquiera con units.view puede leer; otra empresa no las ve', async () => {
    const ventas = (await api.call('GET', '/api/roles', tokA)).body.items.find((r: any) => r.name === 'Ventas');
    await api.call('POST', '/api/team/members', tokA, { username: 'etiquetas1', fullName: 'Solo Lee', password: 'password123', roleIds: [ventas.id] });
    const tokV = (await login(api, 'etiquetas1')).token;
    expect((await api.call('GET', '/api/label-templates', tokV)).status).toBe(200);
    const forbidden = await api.call('POST', '/api/label-templates', tokV, { name: 'x', widthMm: 50, heightMm: 30, layout });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.params.permission).toBe('labels.manage');
    const other = await api.call('GET', '/api/label-templates', tokB);
    expect(other.body.items.every((t: any) => t.id !== tplId)).toBe(true);
    expect((await api.call('PUT', `/api/label-templates/${tplId}`, tokB, { name: 'x', widthMm: 50, heightMm: 30, layout })).status).toBe(404);
  });

  it('los equipos se piden por lote de ids y se elimina la plantilla', async () => {
    const units = (await api.call('GET', '/api/units?pageSize=3', tokA)).body.items;
    const batch = await api.call('GET', `/api/units/batch?ids=${units.map((u: any) => u.id).join(',')}`, tokA);
    expect(batch.body.items.map((u: any) => u.id).sort()).toEqual(units.map((u: any) => u.id).sort());
    expect((await api.call('DELETE', `/api/label-templates/${tplId}`, tokA)).status).toBe(200);
    expect((await api.call('GET', '/api/label-templates', tokA)).body.items.some((t: any) => t.id === tplId)).toBe(false);
  });
});

describe('reglas de ubicación por nivel y ubicación automática al testear', () => {
  let tok: string, mm: ReturnType<typeof metaHelper>;
  let lotId: number, lineA: number, lineB: number, rackId: number;
  const laptop = () => mm.type('laptop');
  let n = 0;

  async function tested(brand: string, model: string, cos: string, fun = 'A') {
    n++;
    const r = await api.call('POST', `/api/lots/${lotId}/units`, tok, {
      equipmentTypeId: laptop(), specs: { brand: mm.item('brand', brand), model: mm.model('laptop', brand, model), ram: mm.item('ram_size', '16') }, serialNumber: `RULE-${n}`,
    });
    expect(r.status).toBe(200);
    const f = await api.call('POST', `/api/units/${r.body.id}/finish-test`, tok, {
      cosmeticGradeId: mm.item('cosmetic_grade', cos), functionalGradeId: mm.item('functional_grade', fun),
      specs: { processor: mm.item('processor', 'Intel Core i7'), storage_size: mm.item('storage_size', '512') },
    });
    expect(f.status).toBe(200);
    return f.body;
  }

  it('prepara empresa, lote y un rack con una regla distinta por nivel', async () => {
    await makeCompany('Gamma Corp', 'adminC');
    tok = (await login(api, 'adminC')).token;
    mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    await mm.ensureModels(api, tok, [['laptop', 'Dell', 'X1'], ['laptop', 'HP', 'Y2'], ['laptop', 'Dell', 'Otro']]);
    const lot = await api.call('POST', '/api/lots', tok, { lines: [
      { equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'Dell'), model: mm.model('laptop', 'Dell', 'X1') }, expectedQty: 4 },
      { equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'HP'), model: mm.model('laptop', 'HP', 'Y2') }, expectedQty: 4 },
    ] });
    lotId = lot.body.id;
    const det = (await api.call('GET', `/api/lots/${lotId}`, tok)).body;
    lineA = det.lines[0].id; lineB = det.lines[1].id;
    await api.call('PUT', `/api/lots/${lotId}/counts`, tok, { counts: [{ lineId: lineA, countedQty: 4 }, { lineId: lineB, countedQty: 4 }] });
    expect((await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'finish_count' })).status).toBe(200);

    const wh = await api.call('POST', '/api/warehouses', tok, { code: 'W', name: 'Bodega' });
    const area = await api.call('POST', '/api/areas', tok, { warehouseId: wh.body.id, code: 'A', name: 'Laptops' });
    const gA = mm.item('cosmetic_grade', 'A'), gB = mm.item('cosmetic_grade', 'B'), gC = mm.item('cosmetic_grade', 'C');
    const rack = await api.call('POST', '/api/racks', tok, { areaId: area.body.id, code: 'R1', layout: { levels: [
      { slots: 2, capacity: 2, rule: { typeId: laptop(), cosmeticGradeIds: [gA], groupBy: ['brand', 'model'], strict: true } },
      { slots: 2, capacity: 5, rule: { typeId: laptop(), cosmeticGradeIds: [gB, gC], groupBy: ['brand'], strict: false } },
      { slots: 1, capacity: 5, rule: { typeId: mm.type('monitor') } },
    ] } });
    expect(rack.status).toBe(200);
    rackId = rack.body.id;
    const tree = (await api.call('GET', '/api/locations/tree', tok)).body;
    const levels = tree.warehouses[0].areas[0].racks[0].levels;
    expect(levels[0].rule).toMatchObject({ typeId: laptop(), cosmeticGradeIds: [gA], groupBy: ['brand', 'model'], strict: true });
    expect(levels[2].rule.groupBy).toEqual([]);
  });

  it('valida propiedades que no pertenecen al tipo', async () => {
    const bad = await api.call('PUT', `/api/racks/${rackId}/layout`, tok, { levels: [
      { slots: 2, capacity: 2, rule: { typeId: mm.type('monitor'), groupBy: ['processor'] } }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('rule_invalid_attribute');
    const dup = await api.call('PUT', `/api/racks/${rackId}/layout`, tok, { levels: [
      { slots: 2, capacity: 2, rule: { typeId: laptop(), groupBy: ['brand', 'brand'] } }] });
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe('rule_duplicate_attribute');
  });

  it('al terminar el testeo cada equipo queda solo en el nivel que le corresponde', async () => {
    const dell1 = await tested('Dell', 'X1', 'A');
    const dell2 = await tested('Dell', 'X1', 'A');
    const hp1 = await tested('HP', 'Y2', 'A');
    expect(dell1.autoPlaced.slotCode).toBe('W/A/R1/1-1');
    expect(dell2.autoPlaced.slotCode).toBe('W/A/R1/1-1');              // mismo grupo: juntos
    expect(hp1.autoPlaced.slotCode).toBe('W/A/R1/1-2');                // otro grupo: no se mezcla (estricto)
    const b = await tested('Dell', 'X1', 'B');
    expect(b.autoPlaced.slotCode.startsWith('W/A/R1/2-')).toBe(true);  // grado B → nivel 2
    const b2 = await tested('Dell', 'Otro', 'C');
    expect(b2.autoPlaced.slotCode).toBe(b.autoPlaced.slotCode);        // agrupa por marca, sin mezclar
    const b3 = await tested('HP', 'Y2', 'B');
    expect(b3.autoPlaced.slotCode).not.toBe(b.autoPlaced.slotCode);
    expect(b3.slotCode).toBe(b3.autoPlaced.slotCode);
  });

  it('sin nivel que lo admita el equipo se testea igual y queda sin ubicar; ubicar a mano avisa', async () => {
    const d = await tested('Dell', 'X1', 'D');
    expect(d.statusKey).toBe('available');
    expect(d.autoPlaced).toBeNull();
    expect(d.slotId).toBeNull();
    const slots = (await api.call('GET', '/api/locations/slots', tok)).body.items;
    const l3 = slots.find((s: any) => s.code.endsWith('/3-1'));
    const r = await api.call('POST', '/api/locations/assign', tok, { assignments: [{ unitId: d.id, slotId: l3.id }] });
    expect(r.status).toBe(200);
    expect(r.body.warnings).toHaveLength(1);
  });

  it('se puede desactivar la ubicación automática', async () => {
    const cur = (await api.call('GET', '/api/company', tok)).body;
    expect((await api.call('PATCH', '/api/company', tok, { settings: { autoPlaceOnTest: false } })).status).toBe(200);
    const u = await tested('Dell', 'X1', 'A');
    expect(u.autoPlaced).toBeNull();
    expect(cur.settings.autoPlaceOnTest).toBe(true);
  });
});

describe('administrador principal único', () => {
  it('solo puede existir uno y nadie más lo modifica', async () => {
    const D = await makeCompany('Delta', 'ownerD');
    const E = await makeCompany('Epsilon', 'adminE');
    await pool.query("UPDATE users SET is_platform_admin = true WHERE username = 'ownerD'");
    // un segundo administrador principal es imposible (índice único)
    await expect(pool.query("UPDATE users SET is_platform_admin = true WHERE username = 'adminE'")).rejects.toThrow();

    const tokO = (await login(api, 'ownerD')).token;
    const tokE = (await login(api, 'adminE')).token;
    const bob = await api.call('POST', '/api/team/members', tokO, { username: 'bobD', fullName: 'Bob', password: 'password123', isCompanyAdmin: true });
    expect(bob.status).toBe(200);
    const tokBob = (await login(api, 'bobD', 'password123', D.id)).token;

    const members = (await api.call('GET', '/api/team/members', tokBob)).body.items;
    const owner = members.find((x: any) => x.username === 'ownerD');
    expect(owner.isOwner).toBe(true);
    expect(members.find((x: any) => x.username === 'bobD').isOwner).toBe(false);

    // Bob es administrador de la empresa pero no puede tocar al principal
    const edit = await api.call('PUT', `/api/team/members/${owner.id}`, tokBob, { roleIds: [], overrides: [], isActive: false });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe('owner_protected');
    const reset = await api.call('POST', `/api/team/members/${owner.id}/reset-password`, tokBob, { password: 'otraClave123' });
    expect(reset.status).toBe(403);
    // ni otra empresa puede añadirlo como usuario suyo
    const steal = await api.call('POST', '/api/team/members', tokE, { username: 'ownerD', fullName: 'Nombre' });
    expect(steal.status).toBe(403);
    expect(steal.body.error.code).toBe('owner_protected');
    // crear empresas: solo el principal
    expect((await api.call('POST', '/api/platform/companies', tokBob, { name: 'Nueva', admin: { username: 'z1z', fullName: 'Z', password: 'password123' } })).status).toBe(403);
    const created = await api.call('POST', '/api/platform/companies', tokO, { name: 'Nueva SA', admin: { username: 'zeta1', fullName: 'Zeta Uno', password: 'password123' } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    // el principal sí puede cambiar sus propios datos
    const own = await api.call('PUT', `/api/team/members/${owner.id}`, tokO, { roleIds: [], overrides: [], fullName: 'Dueño' });
    expect(own.status).toBe(200);
    void E;
  });
});

describe('pedidos por líneas y equipos escogidos del rack', () => {
  let tok: string, mm: ReturnType<typeof metaHelper>;
  let lotId: number, customerId: number, orderId: number;
  const codes: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const laptop = () => mm.type('laptop');
  let n = 0;

  async function tested(key: string, brand: string, model: string, cos: string) {
    n++;
    const r = await api.call('POST', `/api/lots/${lotId}/units`, tok, {
      equipmentTypeId: laptop(), specs: { brand: mm.item('brand', brand), model: mm.model('laptop', brand, model), ram: mm.item('ram_size', '16') }, serialNumber: `PED-${n}`,
    });
    const f = await api.call('POST', `/api/units/${r.body.id}/finish-test`, tok, {
      cosmeticGradeId: mm.item('cosmetic_grade', cos), functionalGradeId: mm.item('functional_grade', 'A'),
      specs: { processor: mm.item('processor', 'Intel Core i7'), storage_size: mm.item('storage_size', '512') },
    });
    expect(f.status).toBe(200);
    codes[key] = f.body.code; ids[key] = f.body.id;
    return f.body;
  }

  it('prepara stock ubicado', async () => {
    await makeCompany('Zeta Trading', 'adminZ');
    tok = (await login(api, 'adminZ')).token;
    mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    await mm.ensureModels(api, tok, [['laptop', 'Dell', 'X1'], ['laptop', 'HP', 'Y2']]);
    const lot = await api.call('POST', '/api/lots', tok, { lines: [{ equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'Dell'), model: mm.model('laptop', 'Dell', 'X1') }, expectedQty: 6 }] });
    lotId = lot.body.id;
    const line = (await api.call('GET', `/api/lots/${lotId}`, tok)).body.lines[0].id;
    await api.call('PUT', `/api/lots/${lotId}/counts`, tok, { counts: [{ lineId: line, countedQty: 6 }] });
    await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'finish_count' });
    const wh = await api.call('POST', '/api/warehouses', tok, { code: 'Z', name: 'Bodega' });
    const area = await api.call('POST', '/api/areas', tok, { warehouseId: wh.body.id, code: 'A', name: 'Laptops' });
    await api.call('POST', '/api/racks', tok, { areaId: area.body.id, code: 'R1', layout: { levels: [{ slots: 3, capacity: 5 }] } });
    await tested('dellA1', 'Dell', 'X1', 'A');
    await tested('dellA2', 'Dell', 'X1', 'A');
    await tested('dellB1', 'Dell', 'X1', 'B');
    await tested('hpA1', 'HP', 'Y2', 'A');
    await tested('hpA2', 'HP', 'Y2', 'A');
    customerId = (await api.call('POST', '/api/customers', tok, { name: 'Cliente Pedidos' })).body.id;
  });

  it('un pedido se crea con líneas por tipo (sin códigos) y muestra disponibilidad', async () => {
    const o = await api.call('POST', '/api/orders', tok, { customerId, lines: [
      { equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'Dell') }, cosmeticGradeIds: [mm.item('cosmetic_grade', 'A')], quantity: 2, unitPrice: 100 },
      { equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'HP') }, quantity: 3, unitPrice: 90 },
    ] });
    expect(o.status).toBe(200);
    orderId = o.body.id;
    const d = (await api.call('GET', `/api/orders/${orderId}`, tok)).body;
    expect(d.lines.map((l: any) => [l.lineNo, l.quantity, l.picked, l.available])).toEqual([[1, 2, 0, 2], [2, 3, 0, 2]]);
    expect(d.requested).toBe(5);
    expect(d.itemCount).toBe(0);
  });

  it('valida las características de una línea', async () => {
    const bad = await api.call('POST', `/api/orders/${orderId}/lines`, tok, { equipmentTypeId: laptop(), specs: { nope: 1 }, quantity: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('unknown_attribute');
  });

  it('agregar por código compara con el pedido, avisa de diferencias y deja agregarlas igual', async () => {
    const r = await api.call('POST', `/api/orders/${orderId}/pick`, tok, {
      codes: [codes.dellA1, codes.dellB1, codes.hpA1, 'NO-EXISTE', codes.dellA1],
    });
    expect(r.status).toBe(200);
    const by = (c: string) => r.body.results.find((x: any) => x.input === c);
    expect(by(codes.hpA1)).toMatchObject({ outcome: 'added', match: 'ok' });
    expect(by(codes.dellB1)).toMatchObject({ outcome: 'added', match: 'no_match' });   // grado B: la línea pide A → alerta, pero se agrega
    expect(by('NO-EXISTE').outcome).toBe('not_found');
    expect(r.body.results.filter((x: any) => x.input === codes.dellA1).map((x: any) => x.outcome)).toEqual(['added', 'duplicate']);
    expect(r.body.order.itemCount).toBe(3);
    expect(r.body.order.offOrder).toBe(1);
    expect(r.body.order.lines.map((l: any) => l.picked)).toEqual([1, 1]);
    expect((await api.call('GET', `/api/units/${ids.dellB1}`, tok)).body.statusKey).toBe('reserved');

    const again = await api.call('POST', `/api/orders/${orderId}/pick`, tok, { codes: [codes.hpA1] });
    expect(again.body.results[0].outcome).toBe('already_in_order');
  });

  it('línea completa: el equipo extra se agrega pero se avisa', async () => {
    const r = await api.call('POST', `/api/orders/${orderId}/pick`, tok, { codes: [codes.dellA2] });
    expect(r.body.results[0]).toMatchObject({ outcome: 'added', match: 'ok' });         // completa la línea 1 (2 de 2)
    const o2 = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'HP') }, quantity: 1 }] });
    const x = await api.call('POST', `/api/orders/${o2.body.id}/pick`, tok, { codes: [codes.hpA2] });
    expect(x.body.results[0].match).toBe('ok');
    const y = await api.call('POST', `/api/orders/${o2.body.id}/pick`, tok, { codes: ['zzz'] });
    expect(y.body.results[0].outcome).toBe('not_found');
    // el equipo ya reservado en otro pedido no se puede agregar
    const z = await api.call('POST', `/api/orders/${orderId}/pick`, tok, { codes: [codes.hpA2] });
    expect(z.body.results[0]).toMatchObject({ outcome: 'not_available', status: 'reserved' });
  });

  it('el listado indica dónde están los equipos agregados y dónde buscar los que faltan', async () => {
    const pl = (await api.call('GET', `/api/orders/${orderId}/pick-list`, tok)).body;
    const total = pl.picked.reduce((a: number, g: any) => a + g.units.length, 0);
    expect(total).toBe(4);
    expect(pl.picked.every((g: any) => g.slotCode?.startsWith('Z/A/R1/'))).toBe(true);
    // falta 2 de la línea HP (pedía 3, se agregó 1) y no queda stock disponible de HP
    const hp = pl.pending.find((p: any) => p.lineNo === 2);
    expect(hp.remaining).toBe(2);
    expect(hp.shortage).toBe(2);
    expect(pl.pending.find((p: any) => p.lineNo === 1)).toBeUndefined();               // línea 1 completa
  });

  it('reservar automáticamente lo que falta de una línea, y quitar una línea deja los equipos marcados', async () => {
    const o3 = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: laptop(), specs: { brand: mm.item('brand', 'Dell') }, quantity: 3 }] });
    const lineId = (await api.call('GET', `/api/orders/${o3.body.id}`, tok)).body.lines[0].id;
    const f = await api.call('POST', `/api/orders/${o3.body.id}/lines/${lineId}/fill`, tok);
    expect(f.status).toBe(200);
    expect(f.body.filled).toBe(0);                                                        // los Dell ya están en otro pedido
    expect(f.body.missing).toBe(3);
    // liberar y volver a intentar
    const items = (await api.call('GET', `/api/orders/${orderId}`, tok)).body.items;
    await api.call('POST', `/api/orders/${orderId}/items/remove`, tok, { itemIds: items.filter((i: any) => i.code === codes.dellB1).map((i: any) => i.id) });
    const f2 = await api.call('POST', `/api/orders/${o3.body.id}/lines/${lineId}/fill`, tok);
    expect(f2.body.filled).toBe(1);
    expect(f2.body.lines[0].picked).toBe(1);
    const del = await api.call('DELETE', `/api/orders/${o3.body.id}/lines/${lineId}`, tok);
    expect(del.body.lines).toHaveLength(0);
    expect(del.body.items[0].matchStatus).toBe('no_match');
    const qty = await api.call('POST', `/api/orders/${o3.body.id}/lines`, tok, { equipmentTypeId: laptop(), quantity: 1 });
    expect(qty.body.lines).toHaveLength(1);
  });
});

describe('reportes personalizados y panel por permisos', () => {
  let tok: string, mm: ReturnType<typeof metaHelper>;
  let tokVentas: string, tokTec: string, tokRead: string;
  let membVentas: number;
  let lotId: number, orderId: number;
  const codes: string[] = [];
  const run = (t: string, id: number) => api.call('POST', `/api/reports/${id}/run?lang=es`, t);
  const preview = (t: string, dataset: string, definition: any) => api.call('POST', '/api/reports/preview?lang=es', t, { dataset, definition });
  const col = (r: any, key: string) => r.columns.findIndex((c: any) => c.key === key);

  it('prepara empresa con equipos testeados, un pedido vendido y usuarios con distintos roles', async () => {
    await makeCompany('Omega Reportes', 'adminO');
    tok = (await login(api, 'adminO')).token;
    mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    await mm.ensureModels(api, tok, [['laptop', 'Dell', 'X1'], ['laptop', 'Dell', 'M1'], ['laptop', 'Dell', 'M2'], ['laptop', 'HP', 'M3']]);
    const laptop = mm.type('laptop');
    const lot = await api.call('POST', '/api/lots', tok, { lines: [{ equipmentTypeId: laptop, specs: { brand: mm.item('brand', 'Dell'), model: mm.model('laptop', 'Dell', 'X1') }, expectedQty: 4 }] });
    lotId = lot.body.id;
    const line = (await api.call('GET', `/api/lots/${lotId}`, tok)).body.lines[0].id;
    await api.call('PUT', `/api/lots/${lotId}/counts`, tok, { counts: [{ lineId: line, countedQty: 4 }] });
    await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'finish_count' });
    const combos: [string, string][] = [['Dell', 'A'], ['Dell', 'B'], ['HP', 'A']];
    let n = 0;
    for (const [brand, cos] of combos) {
      n++;
      const r = await api.call('POST', `/api/lots/${lotId}/units`, tok, { equipmentTypeId: laptop, specs: { brand: mm.item('brand', brand), model: mm.model('laptop', brand, 'M' + n), ram: mm.item('ram_size', '16') }, serialNumber: `REP-${n}` });
      const f = await api.call('POST', `/api/units/${r.body.id}/finish-test`, tok, {
        cosmeticGradeId: mm.item('cosmetic_grade', cos), functionalGradeId: mm.item('functional_grade', 'A'),
        specs: { processor: mm.item('processor', 'Intel Core i7'), storage_size: mm.item('storage_size', '512') },
      });
      expect(f.status).toBe(200);
      codes.push(f.body.code);
    }
    const cu = await api.call('POST', '/api/customers', tok, { name: 'Cliente Reporte' });
    const o = await api.call('POST', '/api/orders', tok, { customerId: cu.body.id, lines: [{ equipmentTypeId: laptop, quantity: 2, unitPrice: 150 }] });
    orderId = o.body.id;
    await api.call('POST', `/api/orders/${orderId}/pick`, tok, { codes: [codes[0], codes[2]] });
    expect((await api.call('POST', `/api/orders/${orderId}/complete`, tok)).status).toBe(200);

    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    const mk = async (username: string, roleName: string) => {
      const r = await api.call('POST', '/api/team/members', tok, { username, fullName: username, password: 'password123', roleIds: [roles.find((x: any) => x.name === roleName).id] });
      expect(r.status).toBe(200);
      return { id: r.body.id as number, token: (await login(api, username)).token };
    };
    const v = await mk('ventasO', 'Ventas'); tokVentas = v.token; membVentas = v.id;
    tokTec = (await mk('tecnicoO', 'Técnico')).token;
    tokRead = (await mk('lecturaO', 'Solo consulta')).token;
  });

  it('cada empresa nace con reportes de fábrica y se ejecutan', async () => {
    const list = (await api.call('GET', '/api/reports', tok)).body;
    const sys = list.filter((r: any) => r.systemKey);
    expect(sys.map((r: any) => r.systemKey)).toEqual(expect.arrayContaining(['inventory_stock', 'stock_by_type_grade', 'sold_units', 'revenue_by_customer', 'slot_occupancy']));
    const inv = sys.find((r: any) => r.systemKey === 'inventory_stock');
    const r = (await run(tok, inv.id)).body;
    expect(r.rows).toHaveLength(1);                                   // 3 testeados: 2 vendidos + 1 disponible
    expect(r.columns[0].key).toBe('code');
    expect(r.rows[0][0]).toBe(codes[1]);

    const byType = sys.find((x: any) => x.systemKey === 'stock_by_type_grade');
    const g = (await run(tok, byType.id)).body;
    expect(g.rows).toEqual([['Laptop', 'Buen estado', 'Funciona al 100%', 1]]);
  });

  it('agrupa por atributos, filtra por tipo de dato y respeta el orden de columnas', async () => {
    const p = await preview(tok, 'units', {
      mode: 'summary',
      columns: [{ field: 'attr:brand' }, { field: 'cosmetic' }, { field: '*', agg: 'count' }],
      filters: [{ field: 'code', op: 'contains', a: 't' }],
      sort: [{ col: 2, dir: 'desc' }],
    });
    expect(p.status).toBe(200);
    expect(p.body.columns.map((c: any) => c.label)).toEqual(['Marca', 'Grado cosmético', 'Cantidad']);
    const total = p.body.rows.reduce((a: number, r: any[]) => a + r[2], 0);
    expect(total).toBe(3);
    expect(p.body.rows).toContainEqual(['Dell', 'Buen estado', 1]);
    expect(p.body.rows).toContainEqual(['HP', 'Como nuevo', 1]);

    // orden de columnas libre: cantidad primero
    const q = await preview(tok, 'units', { mode: 'summary', columns: [{ field: '*', agg: 'count' }, { field: 'attr:brand' }], filters: [], sort: [{ col: 1, dir: 'asc' }] });
    expect(q.body.rows).toEqual([[2, 'Dell'], [1, 'HP']]);

    // filtros dinámicos: select, fecha relativa, booleano, número
    const f = await preview(tok, 'units', {
      mode: 'detail', columns: [{ field: 'code' }, { field: 'ageDays' }],
      filters: [
        { field: 'cosmetic', op: 'in', list: [String(mm.item('cosmetic_grade', 'A'))] },
        { field: 'createdAt', op: 'lastDays', a: '7' },
        { field: 'placed', op: 'is', a: 'false' },
        { field: 'ageDays', op: 'between', a: '0', b: '5' },
      ], sort: [],
    });
    expect(f.status).toBe(200);
    expect(f.body.rows.length).toBe(2);
    expect((await preview(tok, 'units', { mode: 'detail', columns: [{ field: 'code' }], filters: [{ field: 'createdAt', op: 'lastDays', a: '0' }], sort: [] })).status).toBe(400);
  });

  it('valida la definición y no permite inyectar SQL', async () => {
    const need = await preview(tok, 'units', { mode: 'summary', columns: [{ field: 'code' }], filters: [], sort: [] });
    expect(need.body.error.code).toBe('report_needs_aggregate');
    const unk = await preview(tok, 'units', { mode: 'detail', columns: [{ field: "code; DROP TABLE units" }], filters: [], sort: [] });
    expect(unk.body.error.code).toBe('report_field_unknown');
    const bad = await preview(tok, 'units', { mode: 'detail', columns: [{ field: 'code' }], filters: [{ field: 'code', op: 'gt', a: '1' }], sort: [] });
    expect(bad.body.error.code).toBe('report_invalid_definition');
    const inj = await preview(tok, 'units', { mode: 'detail', columns: [{ field: 'code' }], filters: [{ field: 'code', op: 'contains', a: "'; DROP TABLE units; --" }], sort: [] });
    expect(inj.status).toBe(200);
    expect(inj.body.rows).toHaveLength(0);
    expect((await api.call('GET', '/api/units', tok)).body.items.length).toBe(3);
    const ds = await preview(tok, 'nope', { mode: 'detail', columns: [{ field: 'code' }], filters: [], sort: [] });
    expect(ds.body.error.code).toBe('report_dataset_unknown');
    const sum = await preview(tok, 'units', { mode: 'summary', columns: [{ field: 'code', agg: 'sum' }], filters: [], sort: [] });
    expect(sum.body.error.code).toBe('report_invalid_definition');
  });

  it('un reporte privado solo lo ve quien lo creó (ni siquiera el administrador)', async () => {
    const def = { mode: 'detail', columns: [{ field: 'code', label: 'Mi código' }, { field: 'type' }], filters: [], sort: [] };
    const c = await api.call('POST', '/api/reports', tokVentas, { name: 'Privado de ventas', dataset: 'units', definition: def });
    expect(c.status).toBe(200);
    const id = c.body.id;
    expect((await run(tokVentas, id)).body.columns[0].label).toBe('Mi código');
    expect((await api.call('GET', `/api/reports/${id}`, tok)).status).toBe(404);
    expect((await run(tok, id)).status).toBe(404);
    expect((await api.call('GET', '/api/reports', tok)).body.some((r: any) => r.id === id)).toBe(false);
    expect((await api.call('PUT', `/api/reports/${id}`, tok, { name: 'x', dataset: 'units', definition: def })).status).toBe(404);
    expect((await api.call('DELETE', `/api/reports/${id}`, tok)).status).toBe(404);
    // el dueño lo edita y lo borra
    expect((await api.call('PUT', `/api/reports/${id}`, tokVentas, { name: 'Renombrado', dataset: 'units', definition: def })).status).toBe(200);
    expect((await api.call('GET', '/api/reports', tokVentas)).body.find((r: any) => r.id === id)).toMatchObject({ name: 'Renombrado', mine: true, canEdit: true });
    expect((await api.call('DELETE', `/api/reports/${id}`, tokVentas)).status).toBe(200);
    expect((await api.call('GET', `/api/reports/${id}`, tokVentas)).status).toBe(404);
  });

  it('compartir con la empresa exige reports.share; los de fábrica no se editan pero se duplican', async () => {
    const def = { mode: 'detail', columns: [{ field: 'code' }], filters: [], sort: [] };
    const denied = await api.call('POST', '/api/reports', tokVentas, { name: 'Compartido', dataset: 'units', visibility: 'company', definition: def });
    expect(denied.status).toBe(403);
    const ok = await api.call('POST', '/api/reports', tok, { name: 'Compartido', dataset: 'units', visibility: 'company', definition: def });
    expect(ok.status).toBe(200);
    const seen = (await api.call('GET', '/api/reports', tokVentas)).body.find((r: any) => r.id === ok.body.id);
    expect(seen).toMatchObject({ visibility: 'company', mine: false, canEdit: false });
    expect((await api.call('PUT', `/api/reports/${ok.body.id}`, tokVentas, { name: 'Hack', dataset: 'units', definition: def })).status).toBe(403);
    expect((await api.call('DELETE', `/api/reports/${ok.body.id}`, tokVentas)).status).toBe(403);

    const sys = (await api.call('GET', '/api/reports', tok)).body.find((r: any) => r.systemKey === 'inventory_stock');
    expect((await api.call('PUT', `/api/reports/${sys.id}`, tok, { name: 'x', dataset: 'units', definition: def })).body.error.code).toBe('report_system_readonly');
    expect((await api.call('DELETE', `/api/reports/${sys.id}`, tok)).body.error.code).toBe('report_system_readonly');
    const dup = await api.call('POST', `/api/reports/${sys.id}/duplicate?lang=en`, tokVentas);
    expect(dup.status).toBe(200);
    const copy = (await api.call('GET', `/api/reports/${dup.body.id}`, tokVentas)).body;
    expect(copy).toMatchObject({ name: 'Inventario en existencia (copy)', visibility: 'private', canEdit: true });
    expect((await api.call('GET', `/api/reports/${dup.body.id}`, tok)).status).toBe(404);
  });

  it('solo se usa información que el usuario puede ver: conjuntos, campos de precio y reportes de fábrica', async () => {
    // técnico: sin ventas
    const listT = (await api.call('GET', '/api/reports', tokTec)).body.map((r: any) => r.systemKey);
    expect(listT).toContain('inventory_stock');
    expect(listT).not.toContain('orders_open');
    expect(listT).not.toContain('sold_units');
    const defOrders = { mode: 'detail', columns: [{ field: 'code' }], filters: [], sort: [] };
    expect((await preview(tokTec, 'orders', defOrders)).body.error.code).toBe('report_dataset_forbidden');
    const metaT = (await api.call('GET', '/api/reports/meta?lang=es', tokTec)).body;
    expect(metaT.datasets.map((d: any) => d.key)).not.toContain('orders');
    const unitFieldsT = metaT.datasets.find((d: any) => d.key === 'units').fields.map((f: any) => f.key);
    expect(unitFieldsT).not.toContain('customer');            // datos de ventas
    expect(unitFieldsT).not.toContain('soldPrice');
    expect(unitFieldsT).toContain('attr:brand');
    expect((await preview(tokTec, 'units', { mode: 'detail', columns: [{ field: 'customer' }], filters: [], sort: [] })).body.error.code).toBe('report_field_forbidden');
    expect((await preview(tokTec, 'units', { mode: 'detail', columns: [{ field: 'code' }], filters: [{ field: 'customer', op: 'contains', a: 'x' }], sort: [] })).status).toBe(403);

    // ventas sin precios
    await api.call('PUT', `/api/team/members/${membVentas}`, tok, {
      roleIds: (await api.call('GET', '/api/roles', tok)).body.items.filter((r: any) => r.name === 'Ventas').map((r: any) => r.id),
      overrides: [{ permission: 'sales.price', effect: 'deny' }, { permission: 'sales.view_all', effect: 'allow' }],
    });
    const listV = (await api.call('GET', '/api/reports', tokVentas)).body;
    expect(listV.map((r: any) => r.systemKey)).toContain('sold_units');
    expect(listV.map((r: any) => r.systemKey)).not.toContain('revenue_by_customer');        // resumen con sumas de precio
    const sold = listV.find((r: any) => r.systemKey === 'sold_units');
    const rs = (await run(tokVentas, sold.id)).body;
    expect(rs.columns.map((c: any) => c.key)).not.toContain('price');                      // la columna de precio se omite
    expect(rs.rows).toHaveLength(2);
    expect((await preview(tokVentas, 'order_items', { mode: 'detail', columns: [{ field: 'price' }], filters: [], sort: [] })).body.error.code).toBe('report_field_forbidden');
    // con precios (administrador) sí
    const admSold = (await api.call('GET', '/api/reports', tok)).body.find((r: any) => r.systemKey === 'sold_units');
    const ra = (await run(tok, admSold.id)).body;
    expect(ra.rows.map((r: any[]) => r[col(ra, 'price')])).toEqual([150, 150]);
    const rev = (await api.call('GET', '/api/reports', tok)).body.find((r: any) => r.systemKey === 'revenue_by_customer');
    const rr = (await run(tok, rev.id)).body;
    expect(rr.rows[0]).toEqual(['Cliente Reporte', 'USD', 2, 300]);
    expect((await run(tokVentas, rev.id)).body.error.code).toBe('report_field_forbidden');   // aunque conozca el id, no obtiene importes
    // sin permiso de crear, el usuario de solo consulta ve reportes pero no los diseña
    expect((await api.call('GET', '/api/reports', tokRead)).status).toBe(200);
    expect((await api.call('POST', '/api/reports', tokRead, { name: 'x', dataset: 'units', definition: defOrders })).status).toBe(403);
  });

  it('el panel solo trae los bloques que el usuario puede ver', async () => {
    const admin = (await api.call('GET', '/api/dashboard', tok)).body;
    expect(Object.keys(admin).sort()).toEqual(['inventory', 'locations', 'lots', 'mine', 'recent', 'sales']);
    expect(admin.inventory.unitsByStatus.reduce((a: number, r: any) => a + r.n, 0)).toBe(3);
    expect(admin.sales.soldMonth).toBe(2);
    expect(admin.sales.revenueByMonth[0]).toMatchObject({ currency: 'USD', total: 300 });
    const tec = (await api.call('GET', '/api/dashboard', tokTec)).body;
    expect(Object.keys(tec).sort()).toEqual(['inventory', 'locations', 'lots', 'mine']);
    const ven = (await api.call('GET', '/api/dashboard', tokVentas)).body;
    expect(ven.sales).toBeDefined();
    expect(ven.sales.revenueByMonth).toBeNull();               // sin permiso de precios no hay dinero
    expect(ven.locations).toBeUndefined();
    expect(ven.recent).toBeUndefined();
  });
});

describe('venta rápida, pedidos sin líneas y eliminar equipos reservados', () => {
  let tok: string, tokTec: string, mm: ReturnType<typeof metaHelper>, customerId: number;

  async function available(serial: string) {
    const lot = await api.call('POST', '/api/lots', tok, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tok, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, tok, { equipmentTypeId: mm.type('generic'), specs: { description: serial }, serialNumber: serial });
    const f = await api.call('POST', `/api/units/${u.body.id}/finish-test`, tok, { cosmeticGradeId: mm.item('cosmetic_grade', 'A'), functionalGradeId: mm.item('functional_grade', 'A') });
    expect(f.status).toBe(200);
    return { id: u.body.id as number, code: f.body.code as string };
  }

  it('prepara empresa y usuario técnico', async () => {
    await makeCompany('Sigma Ventas', 'adminS');
    tok = (await login(api, 'adminS')).token;
    mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    customerId = (await api.call('POST', '/api/customers', tok, { name: 'Cliente S' })).body.id;
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    const r = await api.call('POST', '/api/team/members', tok, { username: 'tecS', fullName: 'tecS', password: 'password123', roleIds: [roles.find((x: any) => x.name === 'Técnico').id] });
    expect(r.status).toBe(200);
    tokTec = (await login(api, 'tecS')).token;
  });

  it('un pedido sin líneas no admite equipos hasta que se defina lo que se vende', async () => {
    const a = await available('SL-1');
    const o = await api.call('POST', '/api/orders', tok, { customerId });
    const byId = await api.call('POST', `/api/orders/${o.body.id}/items`, tok, { unitIds: [a.id] });
    expect(byId.status).toBe(409);
    expect(byId.body.error.code).toBe('order_needs_lines');
    const byCode = await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: [a.code] });
    expect(byCode.status).toBe(409);
    expect(byCode.body.error.code).toBe('order_needs_lines');
    expect((await api.call('GET', `/api/units/${a.id}`, tok)).body.statusKey).toBe('available');
    // con una línea sí
    await api.call('POST', `/api/orders/${o.body.id}/lines`, tok, { equipmentTypeId: mm.type('generic'), quantity: 1 });
    expect((await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: [a.code] })).status).toBe(200);
    expect((await api.call('GET', '/api/orders', tok)).body.items.find((x: any) => x.id === o.body.id).lineCount).toBe(1);
  });

  it('un pedido nuevo creado desde equipos escogidos nace con sus líneas y los reserva', async () => {
    const [a, b] = [await available('FU-1'), await available('FU-2')];
    const o = await api.call('POST', '/api/orders', tok, { customerId, fromUnitIds: [a.id, b.id] });
    expect(o.status).toBe(200);
    const d = (await api.call('GET', `/api/orders/${o.body.id}`, tok)).body;
    expect(d.itemCount).toBe(2);
    expect(d.lines.reduce((n: number, l: any) => n + l.quantity, 0)).toBe(2);   // una línea por cada descripción distinta
    expect(d.lines.length).toBe(2);
    expect(d.offOrder).toBe(0);
  });

  it('pegar varios códigos agrega todos de una vez (y avisa los que fallan)', async () => {
    const [a, b, c] = [await available('PB-1'), await available('PB-2'), await available('PB-3')];
    const o = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: mm.type('generic'), quantity: 3 }] });
    const r = await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: [a.code, b.code, 'NO-EXISTE', c.code, a.code] });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: any) => x.outcome)).toEqual(['added', 'added', 'not_found', 'added', 'duplicate']);
    expect(r.body.order.itemCount).toBe(3);
  });

  it('también se puede agregar por el número de serie (uno a la vez o por lote), no solo por código', async () => {
    const [a, b] = [await available('SER-ONE-1'), await available('SER-BATCH-1')];
    const o = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: mm.type('generic'), quantity: 2 }] });

    // uno a la vez, por serie
    const one = await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: ['ser-one-1'] }); // minúsculas: no distingue mayúsculas
    expect(one.status).toBe(200);
    expect(one.body.results).toEqual([expect.objectContaining({ outcome: 'added', code: a.code })]);

    // por lote, mezclando serie y código en la misma lista
    const batch = await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: ['SER-BATCH-1', 'NO-EXISTE-SERIE'] });
    expect(batch.status).toBe(200);
    expect(batch.body.results.map((x: any) => x.outcome)).toEqual(['added', 'not_found']);
    expect(batch.body.results[0].code).toBe(b.code);
    expect(batch.body.order.itemCount).toBe(2);
  });

  it('venta rápida: solo equipos, sin pedido ni cliente', async () => {
    const [a, b] = [await available('QS-1'), await available('QS-2')];
    const chk = await api.call('POST', '/api/quick-sales/check', tok, { codes: [a.code, 'XX-0', b.code, a.code] });
    expect(chk.status).toBe(200);
    expect(chk.body.results.map((x: any) => x.outcome)).toEqual(['ok', 'not_found', 'ok', 'duplicate']);
    expect(chk.body.results[0].unit.slotCode).toBeDefined();

    const sale = await api.call('POST', '/api/quick-sales', tok, { unitIds: [a.id, b.id] });
    expect(sale.status).toBe(200);
    expect(sale.body.count).toBe(2);
    for (const u of [a, b]) expect((await api.call('GET', `/api/units/${u.id}`, tok)).body.statusKey).toBe('sold');
    const o = (await api.call('GET', `/api/orders/${sale.body.id}`, tok)).body;
    expect(o).toMatchObject({ statusKey: 'completed', isQuick: true, customerId: null, itemCount: 2 });
    const row = (await api.call('GET', '/api/orders', tok)).body.items.find((x: any) => x.id === sale.body.id);
    expect(row).toMatchObject({ isQuick: true, customerName: null, itemCount: 2 });
    expect((await api.call('GET', `/api/orders/${sale.body.id}/packing-list.pdf?lang=es`, tok)).raw.subarray(0, 4).toString()).toBe('%PDF');
    // los equipos vendidos no se pueden volver a vender ni verificar como disponibles
    const again = await api.call('POST', '/api/quick-sales', tok, { unitIds: [a.id] });
    expect(again.status).toBe(409);
    expect((await api.call('POST', '/api/quick-sales/check', tok, { codes: [a.code] })).body.results[0].outcome).toBe('not_available');
    // aparece en los reportes aunque no tenga cliente
    const rep = await api.call('POST', '/api/reports/preview?lang=es', tok, { dataset: 'orders', definition: { mode: 'detail', columns: [{ field: 'code' }, { field: 'customer' }], filters: [], sort: [] } });
    expect(rep.status).toBe(200);
    expect(rep.body.rows.some((r: any[]) => r[0] === sale.body.code)).toBe(true);
  });

  it('venta rápida con cliente y notas opcionales; exige el permiso de completar ventas', async () => {
    const a = await available('QS-3');
    const denied = await api.call('POST', '/api/quick-sales', tokTec, { unitIds: [a.id] });
    expect(denied.status).toBe(403);
    const sale = await api.call('POST', '/api/quick-sales', tok, { unitIds: [a.id], customerId, notes: 'Mostrador' });
    expect(sale.status).toBe(200);
    expect((await api.call('GET', `/api/orders/${sale.body.id}`, tok)).body).toMatchObject({ customerName: 'Cliente S', notes: 'Mostrador', isQuick: true });
  });

  it('eliminar un equipo reservado lo saca del pedido; uno vendido no se puede eliminar', async () => {
    const a = await available('DR-1');
    const o = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: mm.type('generic'), quantity: 1 }] });
    await api.call('POST', `/api/orders/${o.body.id}/pick`, tok, { codes: [a.code] });
    expect((await api.call('GET', `/api/units/${a.id}`, tok)).body.statusKey).toBe('reserved');
    expect((await api.call('DELETE', `/api/units/${a.id}`, tok)).status).toBe(200);
    expect((await api.call('GET', `/api/orders/${o.body.id}`, tok)).body.itemCount).toBe(0);
    const s = await available('DR-2');
    await api.call('POST', '/api/quick-sales', tok, { unitIds: [s.id] });
    const del = await api.call('DELETE', `/api/units/${s.id}`, tok);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('unit_sold');
  });
});

describe('etiquetas de pedido (documentos) y datos de envío', () => {
  let tok: string, tokV: string, customerId: number, orderId: number, orderTpl: number;
  const layout = { elements: [
    { id: 'c', type: 'field', source: 'customer', x: 2, y: 2, w: 90, h: 12, fontSize: 20, bold: true },
    { id: 'w', type: 'field', source: 'weight', label: true, x: 2, y: 16, w: 40, h: 6, fontSize: 12 },
    { id: 'q', type: 'qr', source: 'code', x: 2, y: 24, w: 30, h: 30 },
  ] };

  it('cada empresa tiene una etiqueta de envío predeterminada, separada de la de equipos', async () => {
    await makeCompany('Envios Omega', 'adminEnv');
    tok = (await login(api, 'adminEnv')).token;
    const list = (await api.call('GET', '/api/label-templates', tok)).body.items;
    const defaults = list.filter((t: any) => t.isDefault);
    expect(defaults.map((t: any) => t.kind).sort()).toEqual(['order', 'unit']);
    const order = list.find((t: any) => t.kind === 'order');
    expect(order.typeIds).toEqual([]);
    expect(order.layout.elements.some((e: any) => e.source === 'customer')).toBe(true);
    orderTpl = order.id;
  });

  it('crea plantillas de pedido: no llevan tipos y la predeterminada es una por clase', async () => {
    const ty = metaHelper((await api.call('GET', '/api/meta', tok)).body).type('laptop');
    const a = await api.call('POST', '/api/label-templates', tok, { kind: 'order', name: 'Envío 4x3', widthMm: 102, heightMm: 76, layout, isDefault: true, typeIds: [ty] });
    expect(a.status).toBe(200);
    expect(a.body.kind).toBe('order');
    expect(a.body.typeIds).toEqual([]);
    const list = (await api.call('GET', '/api/label-templates', tok)).body.items;
    expect(list.filter((t: any) => t.kind === 'order' && t.isDefault).map((t: any) => t.id)).toEqual([a.body.id]);
    expect(list.filter((t: any) => t.kind === 'unit' && t.isDefault).length).toBe(1);   // la de equipos no se toca
    // la clase no cambia al editar ni al duplicar
    const put = await api.call('PUT', `/api/label-templates/${a.body.id}`, tok, { kind: 'unit', name: 'Envío 4x3', widthMm: 102, heightMm: 76, layout, typeIds: [ty] });
    expect(put.body.kind).toBe('order');
    expect(put.body.typeIds).toEqual([]);
    const copy = await api.call('POST', `/api/label-templates/${a.body.id}/duplicate`, tok);
    expect(copy.body.kind).toBe('order');
    // si el usuario las borra todas, no reaparecen solas
    for (const t of list.filter((x: any) => x.kind === 'order')) await api.call('DELETE', `/api/label-templates/${t.id}`, tok);
    await api.call('DELETE', `/api/label-templates/${a.body.id}`, tok);
    await api.call('DELETE', `/api/label-templates/${copy.body.id}`, tok);
    const { ensureCompanyDefaults } = await import('../src/services/startup.js');
    await ensureCompanyDefaults();
    expect((await api.call('GET', '/api/label-templates', tok)).body.items.filter((t: any) => t.kind === 'order').length).toBe(0);
  });

  it('el pedido guarda peso, medidas y bultos, aun completado; no en uno cancelado', async () => {
    const mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    customerId = (await api.call('POST', '/api/customers', tok, { name: 'Cliente Envío', address: '100 NW 5th St, Miami FL', phone: '305-555-0100' })).body.id;
    const o = await api.call('POST', '/api/orders', tok, { customerId, lines: [{ equipmentTypeId: mm.type('generic'), quantity: 1 }] });
    orderId = o.body.id;
    const d0 = (await api.call('GET', `/api/orders/${orderId}`, tok)).body;
    expect(d0.shipping).toEqual({ weightUnit: 'lb', dimUnit: 'in', packages: [] });
    expect(d0.customerAddress).toBe('100 NW 5th St, Miami FL');
    expect(d0.customerPhone).toBe('305-555-0100');

    const ship = { weightUnit: 'kg', dimUnit: 'cm', packages: [{ weight: 12.5, length: 60, width: 40, height: 30 }, { weight: 8, length: null, width: null, height: null }] };
    const r = await api.call('PUT', `/api/orders/${orderId}/shipping`, tok, ship);
    expect(r.status).toBe(200);
    expect(r.body.shipping).toEqual(ship);
    expect((await api.call('PUT', `/api/orders/${orderId}/shipping`, tok, { ...ship, weightUnit: 'stone' })).status).toBe(400);
    expect((await api.call('PUT', `/api/orders/${orderId}/shipping`, tok, { ...ship, packages: [{ weight: -1, length: null, width: null, height: null }] })).status).toBe(400);

    // completado (con un equipo) sigue admitiendo cambios de envío
    const lot = await api.call('POST', '/api/lots', tok, { lines: [] });
    await api.call('POST', `/api/lots/${lot.body.id}/transition`, tok, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lot.body.id}/units`, tok, { equipmentTypeId: mm.type('generic'), specs: { description: 'ENV-1' }, serialNumber: 'ENV-1' });
    const f = await api.call('POST', `/api/units/${u.body.id}/finish-test`, tok, { cosmeticGradeId: mm.item('cosmetic_grade', 'A'), functionalGradeId: mm.item('functional_grade', 'A') });
    expect((await api.call('POST', `/api/orders/${orderId}/pick`, tok, { codes: [f.body.code] })).status).toBe(200);
    expect((await api.call('POST', `/api/orders/${orderId}/complete`, tok)).status).toBe(200);
    const again = await api.call('PUT', `/api/orders/${orderId}/shipping`, tok, { ...ship, packages: [ship.packages[0]] });
    expect(again.status).toBe(200);
    expect(again.body.shipping.packages.length).toBe(1);

    const o2 = await api.call('POST', '/api/orders', tok, { customerId });
    await api.call('POST', `/api/orders/${o2.body.id}/cancel`, tok);
    const cancelled = await api.call('PUT', `/api/orders/${o2.body.id}/shipping`, tok, ship);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('order_cancelled');
  });

  it('quien solo tiene ventas puede leer las plantillas para imprimir, pero no diseñarlas', async () => {
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    await api.call('POST', '/api/team/members', tok, { username: 'ventasEnv', fullName: 'Ventas O', password: 'password123', roleIds: [roles.find((r: any) => r.name === 'Ventas').id] });
    tokV = (await login(api, 'ventasEnv')).token;
    expect((await api.call('GET', '/api/label-templates', tokV)).status).toBe(200);
    expect((await api.call('POST', '/api/label-templates', tokV, { kind: 'order', name: 'x', widthMm: 50, heightMm: 30, layout })).status).toBe(403);
    // El pedido es del administrador: quien solo ve lo suyo no puede tocarlo (aparece como inexistente)…
    expect((await api.call('PUT', `/api/orders/${orderId}/shipping`, tokV, { weightUnit: 'lb', dimUnit: 'in', packages: [] })).status).toBe(404);
    // …y con "ver las ventas de todos" sí.
    const mem = (await api.call('GET', '/api/team/members', tok)).body.items.find((x: any) => x.username === 'ventasEnv');
    await api.call('PUT', `/api/team/members/${mem.id}`, tok, { roleIds: [roles.find((r: any) => r.name === 'Ventas').id], overrides: [{ permission: 'sales.view_all', effect: 'allow' }] });
    expect((await api.call('PUT', `/api/orders/${orderId}/shipping`, tokV, { weightUnit: 'lb', dimUnit: 'in', packages: [] })).status).toBe(200);
  });
});

describe('activos de la empresa (herramientas y equipos propios)', () => {
  let tok: string, mm: ReturnType<typeof metaHelper>, assetId: number, tokT: string, tokS: string;
  let catId = 0;
  const mmCat = () => catId;
  const status = (key: string) => mm.sys('asset_status', key);
  const assetPerms = async (token: string, role: string) =>
    ((await api.call('GET', '/api/roles', token)).body.items.find((x: any) => x.name === role).permissions as string[]).filter((p) => p.startsWith('assets.')).sort();

  it('empresa nueva: catálogo de estados de activo y permisos por rol', async () => {
    const co = await makeCompany('Activos SA', 'adminAct');
    tok = (await login(api, 'adminAct')).token;
    mm = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    await mm.ensureModels(api, tok, [['laptop', 'Dell', 'Latitude 5490'], ['laptop', 'Dell', 'Latitude 7490']]);
    expect(status('in_use')).toBeGreaterThan(0);
    catId = (await api.call('GET', '/api/meta', tok)).body.catalogs.find((c: any) => c.key === 'asset_status').id;
    expect(status('retired')).toBeGreaterThan(0);
    for (const [role, perms] of [['Técnico', ['assets.view']], ['Almacén', ['assets.view', 'assets.manage']], ['Ventas', []]] as const) {
      expect(await assetPerms(tok, role)).toEqual([...perms].sort());
    }
    expect(co.id).toBeGreaterThan(0);
  });

  it('registra un activo con los mismos tipos y atributos; código propio A-0001; no aparece en el inventario', async () => {
    const r = await api.call('POST', '/api/assets', tok, {
      equipmentTypeId: mm.type('laptop'), name: 'Laptop de soporte', serialNumber: 'ACT-SN-1',
      specs: { brand: mm.item('brand', 'Dell'), model: mm.model('laptop', 'Dell', 'Latitude 5490') }, assignedTo: 'Carlos', location: 'Oficina', acquiredAt: '2026-01-15', notes: 'Solo uso interno',
    });
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    const a = r.body.items[0];
    assetId = a.id;
    expect(a.code).toBe('A-0001');
    expect(a.statusKey).toBe('in_use');
    expect(a.acquiredAt).toBe('2026-01-15');
    expect(a.specs.model).toBe(mm.model('laptop', 'Dell', 'Latitude 5490'));
    expect((await api.call('GET', '/api/units', tok)).body.items.length).toBe(0);
    expect((await api.call('GET', '/api/units/lookup?code=ACT-SN-1', tok)).status).toBe(404);
    // escaneo: por código o por serie (sin distinguir mayúsculas)
    expect((await api.call('GET', '/api/assets/lookup?code=a-0001', tok)).body.id).toBe(a.id);
    expect((await api.call('GET', '/api/assets/lookup?code=act-sn-1', tok)).body.id).toBe(a.id);
    expect((await api.call('GET', '/api/assets/lookup?code=nada', tok)).status).toBe(404);
  });

  it('valida: serie duplicada, atributo desconocido, estado ajeno y serie con varias unidades', async () => {
    const dup = await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('laptop'), serialNumber: 'act-sn-1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('asset_serial_duplicate');
    expect((await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('laptop'), specs: { nope: 1 } })).status).toBe(400);
    expect((await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('laptop'), statusId: mm.sys('unit_status', 'available') })).status).toBe(400);
    const many = await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('laptop'), serialNumber: 'X', quantity: 3 });
    expect(many.status).toBe(400);
    expect(many.body.error.code).toBe('asset_serial_single');
  });

  it('cantidad: registra varios iguales, cada uno con su código', async () => {
    const r = await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('generic'), name: 'Destornillador', specs: { description: 'Phillips #2' }, quantity: 5, location: 'Taller' });
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.code)).toEqual(['A-0002', 'A-0003', 'A-0004', 'A-0005', 'A-0006']);
    const list = await api.call('GET', '/api/assets?q=phillips', tok);
    expect(list.body.total).toBe(0);           // la búsqueda es por código, nombre, serie, responsable y lugar
    expect((await api.call('GET', '/api/assets?q=destornillador', tok)).body.total).toBe(5);
    expect((await api.call('GET', '/api/assets?q=Carlos', tok)).body.total).toBe(1);
    expect((await api.call('GET', `/api/assets?typeId=${mm.type('generic')}`, tok)).body.total).toBe(5);
    expect((await api.call('GET', `/api/assets?specs=${encodeURIComponent(JSON.stringify({ description: 'Phillips #2' }))}`, tok)).body.total).toBe(5);
  });

  it('edita, cambia de estado (queda en el historial) y cambia de tipo reemplazando datos técnicos', async () => {
    const p = await api.call('PATCH', `/api/assets/${assetId}`, tok, { assignedTo: 'María', statusId: status('repair'), specs: { model: mm.model('laptop', 'Dell', 'Latitude 7490') } });
    expect(p.status).toBe(200);
    expect(p.body.assignedTo).toBe('María');
    expect(p.body.statusKey).toBe('repair');
    expect(p.body.specs.model).toBe(mm.model('laptop', 'Dell', 'Latitude 7490'));
    expect(p.body.specs.brand).toBe(mm.item('brand', 'Dell'));
    const d = (await api.call('GET', `/api/assets/${assetId}`, tok)).body;
    expect(d.history.map((h: any) => h.action).sort()).toEqual(['asset.created', 'asset.status_changed', 'asset.updated']);
    expect(d.history.find((h: any) => h.action === 'asset.updated').data.specs.model).toEqual([mm.model('laptop', 'Dell', 'Latitude 5490'), mm.model('laptop', 'Dell', 'Latitude 7490')]);
    const t = await api.call('PATCH', `/api/assets/${assetId}`, tok, { equipmentTypeId: mm.type('generic'), specs: { description: 'Equipo de pruebas' }, serialNumber: null, name: null });
    expect(t.status).toBe(200);
    expect(t.body.specs).toEqual({ description: 'Equipo de pruebas' });
    expect(t.body.serialNumber).toBeNull();
    expect(t.body.name).toBeNull();
    expect((await api.call('PATCH', `/api/assets/${assetId}`, tok, { serialNumber: 'X1' })).status).toBe(200);
    expect((await api.call('PATCH', `/api/assets/${assetId}`, tok, { acquiredAt: '2026-13-45' })).status).toBe(400);
  });

  it('los estados propios se pueden crear; el de sistema no se borra y uno en uso por un activo tampoco', async () => {
    expect((await api.call('DELETE', `/api/catalog-items/${status('repair')}`, tok)).status).toBe(400);
    const cat = mmCat();
    const it = await api.call('POST', `/api/catalogs/${cat}/items`, tok, { name: { es: 'Prestado', en: 'Lent' }, color: '#8b5cf6' });
    expect(it.status).toBe(200);
    const p = await api.call('PATCH', `/api/assets/${assetId}`, tok, { statusId: it.body.id });
    expect(p.status).toBe(200);
    expect(p.body.statusKey).toBeNull();
    const del = await api.call('DELETE', `/api/catalog-items/${it.body.id}`, tok);
    expect(del.status).toBe(409);
    await api.call('PATCH', `/api/assets/${assetId}`, tok, { statusId: status('in_use') });
    expect((await api.call('DELETE', `/api/catalog-items/${it.body.id}`, tok)).status).toBe(200);
  });

  it('permisos: el técnico ve pero no gestiona; almacén gestiona; ventas ni ve', async () => {
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    const role = (n: string) => roles.find((r: any) => r.name === n).id;
    await api.call('POST', '/api/team/members', tok, { username: 'tecAct', fullName: 'Tec', password: 'password123', roleIds: [role('Técnico')] });
    await api.call('POST', '/api/team/members', tok, { username: 'venAct', fullName: 'Ven', password: 'password123', roleIds: [role('Ventas')] });
    tokT = (await login(api, 'tecAct')).token;
    tokS = (await login(api, 'venAct')).token;
    expect((await api.call('GET', '/api/assets', tokT)).status).toBe(200);
    expect((await api.call('GET', `/api/assets/${assetId}`, tokT)).status).toBe(200);
    expect((await api.call('POST', '/api/assets', tokT, { equipmentTypeId: mm.type('generic') })).status).toBe(403);
    expect((await api.call('PATCH', `/api/assets/${assetId}`, tokT, { notes: 'x' })).status).toBe(403);
    expect((await api.call('DELETE', `/api/assets/${assetId}`, tokT)).status).toBe(403);
    expect((await api.call('GET', '/api/assets', tokS)).status).toBe(403);
    expect((await api.call('GET', '/api/label-templates', tokT)).status).toBe(200);
  });

  it('aislamiento: otra empresa no ve ni toca estos activos y su consecutivo es propio', async () => {
    expect((await api.call('GET', '/api/assets', tokA)).body.total).toBe(0);
    expect((await api.call('GET', `/api/assets/${assetId}`, tokA)).status).toBe(404);
    expect((await api.call('DELETE', `/api/assets/${assetId}`, tokA)).status).toBe(404);
    const mA = metaHelper((await api.call('GET', '/api/meta', tokA)).body);
    const r = await api.call('POST', '/api/assets', tokA, { equipmentTypeId: mA.type('generic'), specs: { description: 'Taladro' } });
    expect(r.body.items[0].code).toBe('A-0001');
    expect((await api.call('GET', `/api/assets?ids=${assetId}`, tokA)).body.total).toBe(0);
  });

  it('formato de código configurable y eliminación con historial', async () => {
    const bad = await api.call('PATCH', '/api/company', tok, { settings: { assetCodeFormat: 'ACT' } });
    expect(bad.status).toBe(400);
    expect((await api.call('PATCH', '/api/company', tok, { settings: { assetCodeFormat: 'ACT-{yy}-{nnn}' } })).status).toBe(200);
    const r = await api.call('POST', '/api/assets', tok, { equipmentTypeId: mm.type('generic'), specs: { description: 'Cable' } });
    expect(r.body.items[0].code).toBe(`ACT-${String(new Date().getUTCFullYear()).slice(2)}-007`);
    const id = r.body.items[0].id;
    expect((await api.call('DELETE', `/api/assets/${id}`, tok)).status).toBe(200);
    expect((await api.call('GET', `/api/assets/${id}`, tok)).status).toBe(404);
    const audit = (await api.call('GET', '/api/audit?entity=asset', tok)).body;
    expect((audit.items ?? []).some((h: any) => h.action === 'asset.deleted')).toBe(true);
  });

  it('empresas anteriores a esta función reciben el catálogo y los permisos una sola vez al arrancar', async () => {
    await makeCompany('Antigua SL', 'adminOld');
    const tk = (await login(api, 'adminOld')).token;
    const co = (await api.call('GET', '/api/meta', tk)).body.company.id;
    // simula una empresa creada antes de la función: sin catálogo, sin marca y sin permisos de activos
    await withTenant(co, async (db) => {
      await db.query(`DELETE FROM catalogs WHERE key = 'asset_status'`);
      await db.query(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE key LIKE 'assets.%')`);
      await db.query(`UPDATE companies SET settings = settings #- '{_seeded,assets}' WHERE id = $1`, [co]);
    });
    const { ensureCompanyDefaults } = await import('../src/services/startup.js');
    await ensureCompanyDefaults();
    const mo = metaHelper((await api.call('GET', '/api/meta', tk)).body);
    expect(mo.sys('asset_status', 'in_use')).toBeGreaterThan(0);
    const perms = (n: string) => assetPerms(tk, n);
    expect(await perms('Administrador')).toEqual(['assets.manage', 'assets.view']);
    expect(await perms('Técnico')).toEqual(['assets.view']);
    expect(await perms('Ventas')).toEqual([]);
    // el administrador quita el permiso al técnico: no reaparece en el siguiente arranque
    const tec = (await api.call('GET', '/api/roles', tk)).body.items.find((x: any) => x.name === 'Técnico');
    await api.call('PUT', `/api/roles/${tec.id}`, tk, { name: tec.name, description: tec.description, permissions: tec.permissions.filter((p: string) => p !== 'assets.view') });
    await ensureCompanyDefaults();
    expect(await perms('Técnico')).toEqual([]);
  });
});
