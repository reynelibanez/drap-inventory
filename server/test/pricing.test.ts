import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let tok: string;
let m: ReturnType<typeof metaHelper>;
let lotId: number;
let lines: { dell: number; hp: number; lg: number };
const units: { dell: number[]; hp: number[]; lg: number[] } = { dell: [], hp: [], lg: [] };

const get = async (url: string, t = tok) => (await api.call('GET', url, t)).body;
const unit = async (id: number, t = tok) => (await api.call('GET', `/api/units/${id}`, t)).body;
const overview = () => get(`/api/lots/${lotId}/costs`);
const row = (ov: any, lineId: number) => ov.rows.find((r: any) => r.lineId === lineId);
const rule = (id: string, method: string, value: number, match: any = {}) => ({ id, method, value, match, enabled: true });

beforeAll(async () => {
  api = await startApi();
  await makeCompany('Precios SA', 'adminP');
  tok = (await login(api, 'adminP')).token;
  m = metaHelper((await api.call('GET', '/api/meta', tok)).body);
  await m.ensureModels(api, tok, [['monitor', 'LG', '27UL500'], ['laptop', 'Dell', 'Latitude'], ['laptop', 'HP', 'EliteBook']]);
});
afterAll(() => stopApi(api));

async function addUnit(kind: 'dell' | 'hp' | 'lg', n: number) {
  const body = kind === 'lg'
    ? { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '27UL500'), screen_size: m.item('screen_size', '24') }, serialNumber: `LG-${n}` }
    : { equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', kind === 'dell' ? 'Dell' : 'HP'), model: m.model('laptop', kind === 'dell' ? 'Dell' : 'HP', kind === 'dell' ? 'Latitude' : 'EliteBook') }, serialNumber: `${kind}-${n}` };
  const r = await api.call('POST', `/api/lots/${lotId}/units`, tok, body);
  expect(r.status).toBe(200);
  const f = await api.call('POST', `/api/units/${r.body.id}/finish-test`, tok, {
    cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A'),
    specs: kind === 'lg' ? {} : { processor: m.item('processor', 'Intel Core i7'), ram: m.item('ram_size', '16'), storage_size: m.item('storage_size', '512') },
  });
  expect(f.body?.error).toBeUndefined();
  expect(f.status).toBe(200);
  units[kind].push(r.body.id);
  return r.body;
}

describe('costos del lote', () => {
  it('prepara un lote contado: 4 Dell, 2 HP, 4 monitores; mercancía 1000 + flete 100 (se reparte) + seguro 50 (no)', async () => {
    const r = await api.call('POST', '/api/lots', tok, {
      totalCost: 1000,
      lines: [
        { equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'Dell'), model: m.model('laptop', 'Dell', 'Latitude') }, expectedQty: 4 },
        { equipmentTypeId: m.type('laptop'), specs: { brand: m.item('brand', 'HP'), model: m.model('laptop', 'HP', 'EliteBook') }, expectedQty: 2 },
        { equipmentTypeId: m.type('monitor'), specs: { brand: m.item('brand', 'LG'), model: m.model('monitor', 'LG', '27UL500'), screen_size: m.item('screen_size', '24') }, expectedQty: 4 },
      ],
    });
    expect(r.body?.error).toBeUndefined();
    expect(r.status).toBe(200);
    lotId = r.body.id;
    const det = await get(`/api/lots/${lotId}`);
    lines = { dell: det.lines[0].id, hp: det.lines[1].id, lg: det.lines[2].id };
    await api.call('PUT', `/api/lots/${lotId}/counts`, tok, { counts: [{ lineId: lines.dell, countedQty: 4 }, { lineId: lines.hp, countedQty: 2 }, { lineId: lines.lg, countedQty: 4 }] });
    expect((await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'finish_count' })).status).toBe(200);
  });

  it('por defecto reparte parejo el costo distribuible y separa lo que no se reparte', async () => {
    const put = await api.call('PUT', `/api/lots/${lotId}/costs`, tok, {
      extras: [{ label: 'Flete', amount: 100, distribute: true }, { label: 'Seguro', amount: 50, distribute: false }],
    });
    expect(put.status).toBe(200);
    expect(put.body.merchandise).toBe(1000);
    expect(put.body.pool).toBe(1100);
    expect(put.body.landed).toBe(1150);
    expect(put.body.status).not.toBe('ok');
    expect(row(put.body, lines.dell).perUnit).toBe(110);

    const applied = await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { apply: true });
    expect(applied.status).toBe(200);
    expect(applied.body.status).toBe('ok');
    expect(row(applied.body, lines.hp).perUnit).toBe(110);
    const det = await get(`/api/lots/${lotId}`);
    expect(det.lines.every((l: any) => l.unitCost === 110)).toBe(true);
  });

  it('los equipos nuevos heredan el costo de su línea', async () => {
    const d = await addUnit('dell', 1);
    const u = await unit(d.id);
    expect(u.cost).toBe(110);
    expect(u.costSource).toBe('plan');
    for (let i = 2; i <= 4; i++) await addUnit('dell', i);
    for (let i = 1; i <= 2; i++) await addUnit('hp', i);
    for (let i = 1; i <= 4; i++) await addUnit('lg', i);
  });

  it('las reglas deciden por tipo, por peso y por monto fijo (y se recalcula solo)', async () => {
    const plan = {
      base: 'equal', qtyBasis: 'auto', auto: true,
      rules: [
        rule('mon', 'unit_amount', 20, { typeIds: [m.type('monitor')] }),
        rule('dell', 'weight', 2, { lineIds: [lines.dell] }),
        rule('hp', 'weight', 1, { lineIds: [lines.hp] }),
      ],
    };
    const prev = await api.call('POST', `/api/lots/${lotId}/costs/preview`, tok, { plan });
    expect(row(prev.body, lines.lg).perUnit).toBe(20);
    expect(row(prev.body, lines.dell).perUnit).toBe(204);
    expect(row(prev.body, lines.hp).perUnit).toBe(102);
    expect(prev.body.warnings).toEqual([]);

    const saved = await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { plan, apply: true });
    expect(saved.body.status).toBe('ok');
    for (const id of units.dell) expect((await unit(id)).cost).toBe(204);
    for (const id of units.lg) expect((await unit(id)).cost).toBe(20);
    expect((await unit(units.hp[0]!)).cost).toBe(102);
  });

  it('un costo fijado a mano en un equipo se respeta y el resto se ajusta solo', async () => {
    const set = await api.call('PUT', `/api/units/${units.dell[0]}/cost`, tok, { cost: 300 });
    expect(set.status).toBe(200);
    const u = await unit(units.dell[0]!);
    expect(u.cost).toBe(300);
    expect(u.costSource).toBe('manual');
    // 1100 − 80 (monitores) − 300 = 720 sobre pesos 3×2 + 2×1 = 8 → 90/peso
    expect((await unit(units.dell[1]!)).cost).toBe(180);
    expect((await unit(units.hp[0]!)).cost).toBe(90);

    // Volver al reparto del lote
    await api.call('PUT', `/api/units/${units.dell[0]}/cost`, tok, { cost: null });
    const back = await unit(units.dell[0]!);
    expect(back.costSource).toBe('plan');
    expect(back.cost).toBe(204);
  });

  it('cambia costos en bloque (porcentaje) y valida', async () => {
    const r = await api.call('POST', '/api/units/costs', tok, { unitIds: units.lg, mode: 'pct', value: 10 });
    expect(r.status).toBe(200);
    expect((await unit(units.lg[0]!)).cost).toBe(22);
    expect((await api.call('POST', '/api/units/costs', tok, { unitIds: units.lg, mode: 'set' })).status).toBe(400);
    await api.call('POST', '/api/units/costs', tok, { unitIds: units.lg, mode: 'plan' });
    expect((await unit(units.lg[0]!)).cost).toBe(20);
  });

  it('sin recálculo automático avisa que está desactualizado y se vuelve a aplicar', async () => {
    const cur = await overview();
    await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { plan: { ...cur.plan, auto: false } });
    await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { extras: [{ label: 'Flete', amount: 200, distribute: true }, { label: 'Seguro', amount: 50, distribute: false }] });
    const ov = await overview();
    expect(ov.pool).toBe(1200);
    expect(ov.status).toBe('stale');
    expect((await unit(units.dell[1]!)).cost).toBe(204); // no cambió solo
    const again = await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { apply: true });
    expect(again.body.status).toBe('ok');
    expect((await unit(units.lg[0]!)).cost).toBe(20);
    expect((await unit(units.dell[1]!)).cost).toBeGreaterThan(204);
    // vuelve a automático
    await api.call('PUT', `/api/lots/${lotId}/costs`, tok, { plan: { ...again.body.plan, auto: true }, apply: true });
  });

  it('guarda y borra planes de costos', async () => {
    const cur = await overview();
    const c = await api.call('POST', '/api/cost-templates', tok, { name: 'Mi plan', plan: cur.plan });
    expect(c.status).toBe(200);
    expect((await api.call('POST', '/api/cost-templates', tok, { name: 'mi PLAN', plan: cur.plan })).status).toBe(409);
    expect((await get('/api/cost-templates')).items).toHaveLength(1);
    expect((await api.call('DELETE', `/api/cost-templates/${c.body.id}`, tok)).status).toBe(200);
  });
});

describe('permisos de costos', () => {
  let tokV: string;
  it('un usuario de Ventas no ve ni cambia costos', async () => {
    const roles = (await get('/api/roles')).items;
    const ventas = roles.find((r: any) => r.name === 'Ventas');
    const mem = await api.call('POST', '/api/team/members', tok, { username: 'ventasP', fullName: 'Ventas P', password: 'password123', roleIds: [ventas.id], overrides: [{ permission: 'sales.view_all', effect: 'allow' }] });
    expect(mem.status).toBe(200);
    tokV = (await login(api, 'ventasP')).token;

    const lot = await get(`/api/lots/${lotId}`, tokV);
    expect(lot.totalCost).toBeNull();
    expect(lot.lines.every((l: any) => l.unitCost === null)).toBe(true);
    const u = await unit(units.dell[1]!, tokV);
    expect(u.cost).toBeNull();
    expect(typeof u.listPrice === 'number' || u.listPrice === null).toBe(true);

    expect((await api.call('GET', `/api/lots/${lotId}/costs`, tokV)).status).toBe(403);
    expect((await api.call('PATCH', `/api/lots/${lotId}`, tokV, { totalCost: 5 })).status).toBe(403);
    expect((await api.call('PUT', `/api/units/${units.dell[1]}/cost`, tokV, { cost: 1 })).status).toBe(403);
    expect((await api.call('PUT', '/api/price-rules', tokV, { rules: [] })).status).toBe(403);
  });

  it('los campos de costo de los reportes están prohibidos sin permiso', async () => {
    const def = (field: string) => ({ mode: 'detail', columns: [{ field: 'code' }, { field }], filters: [], sort: [] });
    const ok = await api.call('POST', '/api/reports/preview?lang=es', tok, { dataset: 'units', definition: def('cost') });
    expect(ok.status).toBe(200);
    const no = await api.call('POST', '/api/reports/preview?lang=es', tokV, { dataset: 'units', definition: def('cost') });
    expect(no.status).toBe(403);
    expect(no.body.error.code).toBe('report_field_forbidden');
  });
});

describe('precios de lista', () => {
  it('las reglas fijan el precio de cada equipo (con redondeo .99) y se ven en el equipo', async () => {
    const rules = [
      { name: 'Laptops +30%', enabled: true, match: { typeIds: [m.type('laptop')] }, method: 'markup_pct', value: 30, rounding: 'x99' },
      { name: 'Monitores', enabled: true, match: { typeIds: [m.type('monitor')] }, method: 'fixed', value: 79, rounding: 'none' },
    ];
    expect((await api.call('PUT', '/api/price-rules', tok, { rules })).status).toBe(200);
    const prev = await api.call('POST', '/api/prices/preview', tok, { scope: 'available' });
    expect(prev.status).toBe(200);
    expect(prev.body.changed).toBeGreaterThan(0);
    // la vista previa no guarda nada
    expect((await unit(units.lg[0]!)).listPrice).toBeNull();

    const r = await api.call('POST', '/api/prices/recalculate', tok, { scope: 'available' });
    expect(r.body.changed).toBe(10);
    expect((await unit(units.lg[0]!)).listPrice).toBe(79);
    const d = await unit(units.dell[1]!);
    expect(d.cost).toBe(224);                   // 1200 − 80 monitores = 1120 sobre 10 pesos → 224 por Dell
    expect(d.listPrice).toBe(290.99);           // 224 × 1.30 = 291.2 → termina en .99
    expect(d.priceSource).toBe('rule');
    expect((await unit(units.hp[0]!)).listPrice).toBe(145.99); // 112 × 1.30 = 145.6
  });

  it('el precio fijado a mano se respeta salvo que se pida sobrescribir', async () => {
    const id = units.dell[1]!;
    expect((await api.call('PUT', `/api/units/${id}/price`, tok, { price: 500 })).status).toBe(200);
    expect((await unit(id)).priceSource).toBe('manual');
    await api.call('POST', '/api/prices/recalculate', tok, { scope: 'available' });
    expect((await unit(id)).listPrice).toBe(500);
    await api.call('POST', '/api/prices/recalculate', tok, { scope: 'available', overwriteManual: true });
    expect((await unit(id)).listPrice).toBe(290.99);
  });

  it('cambiar el costo actualiza el precio calculado por regla', async () => {
    const id = units.dell[2]!;
    await api.call('PUT', `/api/units/${id}/cost`, tok, { cost: 100 });
    expect((await unit(id)).listPrice).toBe(129.99); // 100 × 1.3 = 130 → 129.99
  });

  it('en bloque: porcentaje, monto, margen y volver a las reglas', async () => {
    const ids = [units.lg[0]!, units.lg[1]!];
    await api.call('POST', '/api/units/prices', tok, { unitIds: ids, mode: 'pct', value: 10, rounding: 'unit' });
    expect((await unit(ids[0]!)).listPrice).toBe(87);
    await api.call('POST', '/api/units/prices', tok, { unitIds: ids, mode: 'add', value: -7 });
    expect((await unit(ids[0]!)).listPrice).toBe(80);
    await api.call('POST', '/api/units/prices', tok, { unitIds: ids, mode: 'margin', value: 50 });
    expect((await unit(ids[0]!)).listPrice).toBe(40); // costo 20 → 20/(1−0.5)
    await api.call('POST', '/api/units/prices', tok, { unitIds: ids, mode: 'rules' });
    expect((await unit(ids[0]!)).listPrice).toBe(79);
    expect((await unit(ids[0]!)).priceSource).toBe('rule');
    expect((await api.call('POST', '/api/units/prices', tok, { unitIds: ids, mode: 'margin', value: 100 })).status).toBe(400);
  });
});

describe('pedido: precios, descuentos, total y margen', () => {
  let orderId: number;
  const detail = () => get(`/api/orders/${orderId}`);
  let listSum = 0, costSum = 0;

  it('el precio de cada equipo sale de su precio de lista', async () => {
    const cu = await api.call('POST', '/api/customers', tok, { name: 'Cliente P' });
    const o = await api.call('POST', '/api/orders', tok, { customerId: cu.body.id, lines: [{ equipmentTypeId: m.type('laptop'), quantity: 5 }] });
    orderId = o.body.id;
    const add = await api.call('POST', `/api/orders/${orderId}/items`, tok, { unitIds: [units.dell[1]!, units.dell[3]!, units.hp[0]!] });
    expect(add.status).toBe(200);
    const d = await detail();
    const ids = [units.dell[1]!, units.dell[3]!, units.hp[0]!];
    const us = await Promise.all(ids.map((i) => unit(i)));
    // cada renglón toma el precio de lista del equipo
    expect(d.items.map((i: any) => i.unitPrice).sort()).toEqual(us.map((u: any) => u.listPrice).sort());
    expect(d.subtotal).toBeCloseTo(us.reduce((a: number, u: any) => a + u.listPrice, 0), 2);
    listSum = d.subtotal; costSum = us.reduce((a: number, u: any) => a + u.cost, 0);
  });

  it('descuentos y cargos calculan el total y el margen', async () => {
    const sub = listSum;
    const r = await api.call('PUT', `/api/orders/${orderId}/adjustments`, tok, { adjustments: [{ label: 'Descuento', kind: 'percent', value: -10 }, { label: 'Envío', kind: 'amount', value: 15 }] });
    expect(r.status).toBe(200);
    const d = r.body;
    const disc = Math.round(sub * -10) / 100;
    expect(d.total).toBeCloseTo(sub + disc + 15, 2);
    expect(d.margin.cost).toBeCloseTo(costSum, 2);
    expect(d.margin.revenue).toBeCloseTo(sub + disc, 2); // el envío no cuenta como ganancia
    expect(d.margin.profit).toBeCloseTo(d.margin.revenue - d.margin.cost, 2);
  });

  it('sin permiso de costos el pedido no muestra margen', async () => {
    const tokV = (await login(api, 'ventasP')).token;
    const d = (await api.call('GET', `/api/orders/${orderId}`, tokV)).body;
    expect(d.margin).toBeNull();
    expect(d.total).not.toBeNull();
    const byCost = await api.call('POST', `/api/orders/${orderId}/price-plan/preview`, tokV, { target: 'total', amount: 100, plan: { base: 'by_cost', rules: [] } });
    expect(byCost.status).toBe(403);
  });

  it('un precio total para el pedido se reparte entre los equipos y suma exacto', async () => {
    await api.call('PUT', `/api/orders/${orderId}/adjustments`, tok, { adjustments: [] });
    const plan = { base: 'by_list', qtyBasis: 'auto', auto: true, rules: [] };
    const prev = await api.call('POST', `/api/orders/${orderId}/price-plan/preview`, tok, { target: 'total', amount: 300, plan });
    expect(prev.status).toBe(200);
    expect(prev.body.total).toBe(300);
    const cents = Math.round(prev.body.items.reduce((a: number, i: any) => a + i.price, 0) * 100);
    expect(cents).toBe(30000);
    const applied = await api.call('POST', `/api/orders/${orderId}/price-plan/apply`, tok, { target: 'total', amount: 300, plan });
    expect(applied.status).toBe(200);
    expect(applied.body.total).toBe(300);
    expect(applied.body.subtotal).toBe(300);
    expect(Math.round(applied.body.items.reduce((a: number, i: any) => a + (i.unitPrice ?? 0), 0) * 100)).toBe(30000);
  });

  it('con descuentos, el total pedido incluye los ajustes', async () => {
    await api.call('PUT', `/api/orders/${orderId}/adjustments`, tok, { adjustments: [{ label: 'Descuento', kind: 'percent', value: -10 }, { label: 'Envío', kind: 'amount', value: 15 }] });
    const plan = { base: 'equal', qtyBasis: 'auto', auto: true, rules: [rule('a', 'unit_amount', 50, { specs: { brand: m.item('brand', 'HP') } })] };
    const r = await api.call('POST', `/api/orders/${orderId}/price-plan/apply`, tok, { target: 'total', amount: 300, plan });
    expect(r.status).toBe(200);
    // subtotal necesario: (300 − 15) / 0.90 = 316.67 → HP 50 y el resto (266.67) parejo entre los 2 Dell
    expect(r.body.subtotal).toBe(316.67);
    expect(r.body.total).toBe(300);
    const prices = r.body.items.map((i: any) => i.unitPrice).sort((a: number, b: number) => a - b);
    expect(prices[0]).toBe(50);
    expect(Math.round((prices[1] + prices[2]) * 100)).toBe(26667);
  });
});
