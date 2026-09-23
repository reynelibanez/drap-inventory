import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login, makeCompany, metaHelper, startApi, stopApi, type Api } from './helpers.js';

/**
 * "Solo mis ventas": quien no tiene sales.view_all ve únicamente los pedidos que creó o donde es el vendedor.
 * Se activa/desactiva por rol o por usuario (excepción).
 */
describe('vendedor: solo sus ventas (opcional)', () => {
  let api: Api; let tok: string; let m: ReturnType<typeof metaHelper>;
  let tokV1: string; let tokV2: string; let memV1: number; let memV2: number; let ventasRole: number;
  let customerId: number; let sellerV1: number;
  const ids: Record<string, number> = {};
  let lotId: number;

  const codes = async (t: string) => (await api.call('GET', '/api/orders', t)).body.items.map((o: any) => o.code).sort();

  beforeAll(async () => {
    api = await startApi();
    await makeCompany('Alcance SA', 'adminAlc');
    tok = (await login(api, 'adminAlc')).token;
    m = metaHelper((await api.call('GET', '/api/meta', tok)).body);
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    ventasRole = roles.find((r: any) => r.name === 'Ventas').id;
    const mk = async (username: string) => {
      const r = await api.call('POST', '/api/team/members', tok, { username, fullName: username, password: 'password123', roleIds: [ventasRole] });
      expect(r.status).toBe(200);
      return { id: r.body.id as number, token: (await login(api, username)).token };
    };
    const v1 = await mk('vend1'); const v2 = await mk('vend2');
    tokV1 = v1.token; memV1 = v1.id; tokV2 = v2.token; memV2 = v2.id;
    customerId = (await api.call('POST', '/api/customers', tok, { name: 'Cliente S' })).body.id;
    sellerV1 = (await api.call('POST', '/api/sellers', tok, { name: 'Vendedor 1', membershipId: memV1 })).body.id;
  });
  afterAll(() => stopApi(api));

  it('el rol Ventas de fábrica no trae "ver las ventas de todos"; el administrador y Solo consulta sí', async () => {
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    expect(roles.find((r: any) => r.name === 'Ventas').permissions).not.toContain('sales.view_all');
    expect(roles.find((r: any) => r.name === 'Solo consulta').permissions).toContain('sales.view_all');
    expect(roles.find((r: any) => r.name === 'Administrador').permissions).toContain('sales.view_all');
    const perms = (await api.call('GET', '/api/permissions', tok)).body.items;
    expect(perms.map((p: any) => p.key)).toContain('sales.view_all');
  });

  it('prepara pedidos: uno del vendedor 1 (asignado por el admin), uno propio de cada vendedor y uno sin dueño', async () => {
    const mkOrder = async (t: string, body: any = {}) => {
      const r = await api.call('POST', '/api/orders', t, { customerId, ...body });
      expect(r.status).toBe(200);
      return r.body as { id: number; code: string };
    };
    ids.o1 = (await mkOrder(tok, { sellerId: sellerV1 })).id;   // creado por el admin, vendedor = V1
    ids.o2 = (await mkOrder(tokV2)).id;                          // creado por V2
    ids.o3 = (await mkOrder(tokV1)).id;                          // creado por V1
    ids.o4 = (await mkOrder(tok)).id;                            // del admin, sin vendedor
  });

  it('cada vendedor ve solo sus pedidos; el administrador ve todos', async () => {
    const all = (await api.call('GET', '/api/orders', tok)).body;
    expect(all.total).toBe(4);
    const v1 = (await api.call('GET', '/api/orders', tokV1)).body;
    expect(v1.total).toBe(2);
    const v2 = (await api.call('GET', '/api/orders', tokV2)).body;
    expect(v2.total).toBe(1);
    const byId = (list: any) => list.items.map((o: any) => o.id).sort((a: number, b: number) => a - b);
    expect(byId(v1)).toEqual([ids.o1, ids.o3].sort((a, b) => a - b));
    expect(byId(v2)).toEqual([ids.o2]);
  });

  it('los pedidos ajenos no se pueden abrir, editar, imprimir ni operar (aparecen como inexistentes)', async () => {
    expect((await api.call('GET', `/api/orders/${ids.o2}`, tokV1)).status).toBe(404);
    expect((await api.call('GET', `/api/orders/${ids.o4}`, tokV1)).status).toBe(404);
    expect((await api.call('PATCH', `/api/orders/${ids.o2}`, tokV1, { notes: 'x' })).status).toBe(404);
    expect((await api.call('GET', `/api/orders/${ids.o2}/pick-list`, tokV1)).status).toBe(404);
    expect((await api.call('GET', `/api/orders/${ids.o2}/packing-list.pdf`, tokV1)).status).toBe(404);
    expect((await api.call('POST', `/api/orders/${ids.o2}/cancel`, tokV1)).status).toBe(404);
    // los propios sí (creado por él, o asignado a él por otro)
    expect((await api.call('GET', `/api/orders/${ids.o3}`, tokV1)).status).toBe(200);
    expect((await api.call('GET', `/api/orders/${ids.o1}`, tokV1)).status).toBe(200);
    expect((await api.call('GET', `/api/orders/${ids.o1}/packing-list.pdf`, tokV1)).status).toBe(200);
    expect((await api.call('PATCH', `/api/orders/${ids.o1}`, tokV1, { notes: 'mío' })).status).toBe(200);
    // el administrador sigue viendo todo
    expect((await api.call('GET', `/api/orders/${ids.o2}`, tok)).status).toBe(200);
  });

  it('el panel principal cuenta solo lo suyo', async () => {
    const dv1 = (await api.call('GET', '/api/dashboard', tokV1)).body;
    expect(dv1.sales.openCount).toBe(2);
    expect(dv1.sales.openOrders.map((o: any) => o.id).sort()).toEqual([ids.o1, ids.o3].sort());
    const da = (await api.call('GET', '/api/dashboard', tok)).body;
    expect(da.sales.openCount).toBe(4);
  });

  it('los reportes de ventas también se limitan a lo suyo, y el resto de campos de ventas de equipos se ocultan', async () => {
    const def = { mode: 'detail', columns: [{ field: 'code' }], filters: [], sort: [] };
    const rv = await api.call('POST', '/api/reports/preview?lang=es', tokV1, { dataset: 'orders', definition: def });
    expect(rv.status).toBe(200);
    expect(rv.body.rows.map((r: any) => r[0]).sort()).toEqual((await codes(tokV1)));
    const ra = await api.call('POST', '/api/reports/preview?lang=es', tok, { dataset: 'orders', definition: def });
    expect(ra.body.rows).toHaveLength(4);
    const meta = (await api.call('GET', '/api/reports/meta?lang=es', tokV1)).body;
    const unitFields = meta.datasets.find((d: any) => d.key === 'units').fields.map((f: any) => f.key);
    expect(unitFields).not.toContain('customer');
    expect(unitFields).not.toContain('order');
    const metaA = (await api.call('GET', '/api/reports/meta?lang=es', tok)).body;
    expect(metaA.datasets.find((d: any) => d.key === 'units').fields.map((f: any) => f.key)).toContain('customer');
  });

  it('un equipo reservado por el pedido de otro no muestra de qué pedido es', async () => {
    const lot = await api.call('POST', '/api/lots', tok, { lines: [] });
    lotId = lot.body.id;
    await api.call('POST', `/api/lots/${lotId}/transition`, tok, { action: 'start_testing' });
    const u = await api.call('POST', `/api/lots/${lotId}/units`, tok, { equipmentTypeId: m.type('generic'), specs: { description: 'ALC-1' }, serialNumber: 'ALC-1' });
    const f = await api.call('POST', `/api/units/${u.body.id}/finish-test`, tok, { cosmeticGradeId: m.item('cosmetic_grade', 'A'), functionalGradeId: m.item('functional_grade', 'A') });
    expect(f.status).toBe(200);
    // pedido de V2 con una línea genérica y el equipo reservado
    expect((await api.call('POST', `/api/orders/${ids.o2}/lines`, tok, { equipmentTypeId: m.type('generic'), quantity: 1 })).status).toBe(200);
    expect((await api.call('POST', `/api/orders/${ids.o2}/items`, tok, { unitIds: [u.body.id] })).status).toBe(200);
    const asV1 = (await api.call('GET', `/api/units/${u.body.id}`, tokV1)).body;
    expect(asV1.statusKey).toBe('reserved');
    expect(asV1.orderCode).toBeNull();
    expect(asV1.orderId).toBeNull();
    expect(asV1._orderBy).toBeUndefined();
    const asV2 = (await api.call('GET', `/api/units/${u.body.id}`, tokV2)).body;
    expect(asV2.orderId).toBe(ids.o2);
    const asAdmin = (await api.call('GET', `/api/units/${u.body.id}`, tok)).body;
    expect(asAdmin.orderId).toBe(ids.o2);
    const list = (await api.call('GET', `/api/units?ids=${u.body.id}`, tokV1)).body.items[0];
    expect(list.orderCode).toBeNull();
  });

  it('los avisos de un pedido llegan a sus dueños y a quien ve todo, no a los demás vendedores', async () => {
    const titles = async (t: string) => (await api.call('GET', '/api/notifications', t)).body.items.map((n: any) => n.url);
    // V2 creó o2: no recibe avisos de los pedidos de V1 ni del administrador (o1, o3, o4).
    const v2 = await titles(tokV2);
    for (const id of [ids.o1, ids.o3, ids.o4]) expect(v2).not.toContain(`/orders/${id}`);
    // El administrador (ve todo) sí se entera de los pedidos de los vendedores.
    const adm = await titles(tok);
    expect(adm).toContain(`/orders/${ids.o3}`);
    // El vendedor 1 se entera del pedido que le asignó el administrador (o1) aunque no lo creó.
    expect(await titles(tokV1)).toContain(`/orders/${ids.o1}`);
  });

  it('activar la función a un usuario: la excepción "ver las ventas de todos" le devuelve todo (y quitarla lo vuelve a limitar)', async () => {
    const put = (overrides: any[]) => api.call('PUT', `/api/team/members/${memV1}`, tok, { roleIds: [ventasRole], overrides });
    expect((await put([{ permission: 'sales.view_all', effect: 'allow' }])).status).toBe(200);
    expect((await api.call('GET', '/api/orders', tokV1)).body.total).toBe(4);
    expect((await api.call('GET', `/api/orders/${ids.o2}`, tokV1)).status).toBe(200);
    expect((await put([])).status).toBe(200);
    expect((await api.call('GET', '/api/orders', tokV1)).body.total).toBe(2);
    expect((await api.call('GET', `/api/orders/${ids.o2}`, tokV1)).status).toBe(404);
  });

  it('activar la función a todo un rol: se marca sales.view_all en el rol', async () => {
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    const role = roles.find((r: any) => r.id === ventasRole);
    const withAll = await api.call('PUT', `/api/roles/${ventasRole}`, tok, { name: role.name, description: role.description, permissions: [...role.permissions, 'sales.view_all'] });
    expect(withAll.status).toBe(200);
    expect((await api.call('GET', '/api/orders', tokV2)).body.total).toBe(4);
    const back = await api.call('PUT', `/api/roles/${ventasRole}`, tok, { name: role.name, description: role.description, permissions: role.permissions });
    expect(back.status).toBe(200);
    expect((await api.call('GET', '/api/orders', tokV2)).body.total).toBe(1);
  });

  it('un rol con permiso denegado por usuario ("deny") también limita a quien ya ve todo', async () => {
    const roles = (await api.call('GET', '/api/roles', tok)).body.items;
    const consulta = roles.find((r: any) => r.name === 'Solo consulta').id;
    const r = await api.call('POST', '/api/team/members', tok, { username: 'consulta1', fullName: 'Consulta', password: 'password123', roleIds: [consulta] });
    const t = (await login(api, 'consulta1')).token;
    expect((await api.call('GET', '/api/orders', t)).body.total).toBe(4);
    await api.call('PUT', `/api/team/members/${r.body.id}`, tok, { roleIds: [consulta], overrides: [{ permission: 'sales.view_all', effect: 'deny' }] });
    expect((await api.call('GET', '/api/orders', t)).body.total).toBe(0);
  });
});
