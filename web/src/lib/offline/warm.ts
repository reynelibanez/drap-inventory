import { api } from '../api';
import { fetchAll } from '../useAllRows';
import { cachePrune } from './cache';
import { isOnline } from './net';
import { requestPersistence } from './idb';

/**
 * Prepara la copia local mientras hay conexión: baja lo que se necesita para trabajar sin internet en TODA la aplicación
 * (catálogos, lotes, equipos, pedidos, clientes/vendedores/proveedores, activos, ubicaciones, precios…). Usa las mismas consultas que las
 * pantallas, para que lo guardado sea exactamente lo que después se pide sin conexión; los listados se bajan COMPLETOS, porque de ahí
 * se calculan sin conexión los filtros, búsquedas y fichas que no se hayan visitado. Corre en segundo plano y se detiene si se pierde
 * la conexión.
 */
let warming = false;
let lastRun = 0;
const MIN_GAP = 10 * 60_000;

interface LotRow { id: number; statusKey: string }
interface OrderRow { id: number; statusKey: string }

/** Cuántos detalles (lotes, pedidos) se bajan de una vez: los abiertos primero. */
const DETAILS = 40;

export async function warmCache(can: (p: string) => boolean, force = false): Promise<void> {
  if (warming || !isOnline() || (!force && Date.now() - lastRun < MIN_GAP)) return;
  warming = true;
  lastRun = Date.now();
  const ok = async (fn: () => Promise<unknown>) => { if (!isOnline()) throw new Error('offline'); try { await fn(); } catch (e) { if (!isOnline()) throw e; /* lo demás no es crítico */ } };
  const canAny = (...p: string[]) => p.some(can);
  try {
    void requestPersistence();
    await ok(() => api.get('/meta'));

    // Clientes, vendedores y proveedores: en las listas de las pantallas y en los selectores de pedidos y lotes.
    for (const [perm, path] of [['suppliers.view', '/suppliers'], ['customers.view', '/customers'], ['sellers.view', '/sellers']] as const) {
      if (!can(perm)) continue;
      await ok(() => api.get(`${path}?all=1`));
      await ok(() => fetchAll(path, { active: 'all' }));
    }

    if (canAny('lots.view', 'units.test')) {
      await ok(() => fetchAll<LotRow>('/lots'));
      const testable = await api.get<{ items: LotRow[] }>('/lots?openOnly=1&pageSize=100');
      const active = testable.items.slice(0, DETAILS);
      for (const l of active) {
        await ok(() => api.get(`/lots/${l.id}`));
        if (can('costs.view')) await ok(() => api.get(`/lots/${l.id}/costs`));
        if (l.statusKey === 'counted' || l.statusKey === 'testing') {
          if (canAny('units.view', 'units.test')) {
            await ok(() => fetchAll('/units', { lotId: l.id, sort: 'newest' }));
            await ok(() => fetchAll('/units', { lotId: l.id, sort: 'code' }));
          }
        }
      }
    }

    if (can('units.view')) {
      await ok(() => fetchAll('/units', { sort: 'newest' }));
      await ok(() => fetchAll('/units', { statusKey: 'available', sort: 'oldest' }));
    }

    if (can('sales.view')) {
      const orders = await fetchAll<OrderRow>('/orders');
      const open = orders.filter((o) => o.statusKey === 'open');
      const rest = orders.filter((o) => o.statusKey !== 'open').sort((a, b) => b.id - a.id);
      for (const o of [...open, ...rest].slice(0, DETAILS)) {
        await ok(() => api.get(`/orders/${o.id}`));
        if (o.statusKey === 'open') await ok(() => api.get(`/orders/${o.id}/pick-list`));
      }
      await ok(() => api.get('/orders?statusKey=open&pageSize=100'));
      await ok(() => api.get('/orders?pageSize=15'));
    }

    if (can('assets.view')) await ok(() => fetchAll('/assets', { sort: 'newest' }));

    if (can('locations.view')) {
      await ok(() => api.get('/locations/tree'));
      await ok(() => api.get('/locations/slots?free=1'));
      if (can('units.view')) await ok(() => api.get('/units?placed=no&pageSize=200&sort=oldest'));
    }

    if (canAny('prices.manage', 'sales.price')) await ok(() => api.get('/price-rules'));
    if (canAny('units.view', 'sales.view', 'assets.view')) await ok(() => api.get('/label-templates'));
    if (can('costs.view')) await ok(() => api.get('/cost-templates'));
    if (can('dashboard.view')) await ok(() => api.get('/dashboard'));
    if (can('settings.manage')) await ok(() => api.get('/company'));
    if (canAny('roles.view', 'users.view')) { await ok(() => api.get('/roles')); await ok(() => api.get('/permissions')); }
    if (can('users.view')) await ok(() => api.get('/team/members'));
    await ok(() => api.get('/notifications?limit=8'));
    void cachePrune();
  } catch { /* se perdió la conexión: se reintenta en la próxima ocasión */ lastRun = 0; }
  finally { warming = false; }
}
