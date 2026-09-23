import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';
import { loadDemoData, type DemoSummary } from '../src/services/demoData.js';

/**
 * Los datos de demostración que se cargan al instalar: deben dejar un negocio "en marcha" completo
 * (≥100 equipos en el lote de prueba, todos los estados de lote, pedido y equipo, costos, precios, ubicaciones, activos...).
 */
describe('datos de demostración', () => {
  let api: Api; let tok: string; let companyId: number; let adminUserId: number; let s: DemoSummary;
  const get = async (url: string, t = tok) => (await api.call('GET', url, t)).body;

  beforeAll(async () => {
    api = await startApi();
    const c = await makeCompany('Demo SA', 'adminDemo');
    companyId = c.id; adminUserId = c.adminUserId;
    tok = (await login(api, 'adminDemo')).token;
    s = await loadDemoData(api.app, { companyId, adminUserId, seed: Number(process.env.DEMO_SEED) || 20260101, usernameSuffix: '_demo' });
  }, 180_000);
  afterAll(() => stopApi(api));

  it('el lote de prueba trae al menos 100 equipos y hay lotes en todos los estados', async () => {
    const lots = (await get('/api/lots?pageSize=100')).items as any[];
    expect(lots.length).toBe(5);
    const main = lots.find((l) => l.code === s.mainLotCode);
    const detail = await get(`/api/lots/${main.id}`);
    expect(detail.summary.units).toBeGreaterThanOrEqual(150);
    expect(new Set(lots.map((l) => l.statusKey ?? l.status?.systemKey))).toEqual(new Set(['open', 'counting', 'counted', 'testing', 'closed']));
    expect(detail.lines.some((l: any) => l.isUnexpected)).toBe(true);
    expect(detail.lines.some((l: any) => l.difference < 0)).toBe(true);   // llegó de menos
    expect(detail.lines.some((l: any) => l.difference > 0)).toBe(true);   // llegó de más
  });

  it('hay equipos de varios tipos, marcas y grados, en todos los estados', async () => {
    expect(s.units).toBeGreaterThanOrEqual(200);
    const all = (await get('/api/units?pageSize=1000')).items as any[];
    expect(all.length).toBe(s.units);
    expect(new Set(all.map((u) => u.equipmentTypeId)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(all.map((u) => u.specs?.brand)).size).toBeGreaterThanOrEqual(8);
    expect(new Set(all.map((u) => u.cosmeticGradeId).filter(Boolean)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(all.map((u) => u.testerNumber)).size).toBeGreaterThanOrEqual(3);   // los testearon varios técnicos
    for (const st of ['available', 'reserved', 'sold', 'testing', 'not_sellable']) expect(all.filter((u) => u.statusKey === st).length, st).toBeGreaterThan(0);
    // Números de serie únicos
    const serials = all.map((u) => u.serialNumber).filter(Boolean);
    expect(new Set(serials).size).toBe(serials.length);
  });

  it('todos los equipos tienen costo y precio; los fijados a mano se conservan; casi todos están ubicados', async () => {
    const all = (await get('/api/units?pageSize=1000')).items as any[];
    expect(all.every((u) => u.cost !== null)).toBe(true);
    expect(all.every((u) => u.listPrice !== null)).toBe(true);
    expect(all.some((u) => u.priceSource === 'manual')).toBe(true);
    expect(all.filter((u) => u.slotCode).length).toBeGreaterThan(all.filter((u) => u.statusKey !== 'testing').length * 0.9);
  });

  it('hay pedidos en todos los estados, ventas rápidas y un pedido con equipos faltantes', async () => {
    expect(s.orders).toBe(14);
    expect(s.quickSales).toBe(5);
    const orders = (await get('/api/orders?pageSize=100')).items as any[];
    expect(orders.length).toBe(s.orders + s.quickSales);
    expect(new Set(orders.map((o) => o.statusKey))).toEqual(new Set(['open', 'completed', 'cancelled']));
    expect(orders.filter((o) => o.isQuick).length).toBe(5);
    const open = orders.filter((o) => o.statusKey === 'open');
    const missing = [];
    for (const o of open) { const d = await get(`/api/orders/${o.id}`); if (d.lines.some((l: any) => l.picked < l.quantity)) missing.push(o.code); }
    expect(missing.length).toBeGreaterThanOrEqual(2);
    // Descuentos, cargos y totales
    const withAdj = [];
    for (const o of orders.filter((x) => x.statusKey === 'completed' && !x.isQuick).slice(0, 10)) { const d = await get(`/api/orders/${o.id}`); if (d.adjustments.length) withAdj.push(d); }
    expect(withAdj.length).toBeGreaterThan(0);
    expect(withAdj[0].total).not.toBe(withAdj[0].subtotal);
  });

  it('los vendedores solo ven sus propias ventas y el administrador ve todas', async () => {
    const all = (await get('/api/orders?pageSize=100')).body ?? (await get('/api/orders?pageSize=100'));
    const v1 = (await login(api, 'vendedor1_demo', 'Demo2026!').catch(() => null));
    // Deben cambiar la contraseña al entrar: el inicio de sesión funciona igual, solo lo marca.
    expect(v1).not.toBeNull();
    const own = (await get('/api/orders?pageSize=100', v1!.token)).items as any[];
    expect(own.length).toBeGreaterThan(0);
    expect(own.length).toBeLessThan(all.items.length);
    const users = s.users.map((u) => u.username);
    expect(users).toEqual(['vendedor1', 'vendedor2', 'tecnico1', 'tecnico2', 'almacen1', 'consulta1'].map((u) => u + '_demo'));
  });

  it('clientes, proveedores, vendedores, ubicaciones y activos', async () => {
    expect((await get('/api/customers?pageSize=100')).items.length).toBe(10);
    expect((await get('/api/suppliers?pageSize=100')).items.length).toBe(5);
    expect((await get('/api/sellers?pageSize=100')).items.length).toBe(3);
    const tree = await get('/api/locations/tree');
    expect(JSON.stringify(tree)).toContain('Depósito Hialeah');
    const assets = (await get('/api/assets?pageSize=100')).items as any[];
    expect(assets.length).toBe(s.assets);
    expect(s.assets).toBeGreaterThanOrEqual(16);
    expect(new Set(assets.map((a) => a.statusKey))).toEqual(new Set(['in_use', 'stored', 'repair', 'retired']));
  });

  it('los costos de los lotes se repartieron y hay reglas de precio', async () => {
    const lots = (await get('/api/lots?pageSize=100')).items as any[];
    const main = lots.find((l) => l.code === s.mainLotCode);
    const c = await get(`/api/lots/${main.id}/costs`);
    expect(c.status).toBe('ok');
    expect(c.landed).toBeGreaterThan(19500);
    const rules = await get('/api/price-rules');
    expect(rules.rules.length).toBeGreaterThanOrEqual(6);
  });
});
