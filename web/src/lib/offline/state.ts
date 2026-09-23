import { cacheEntries, cacheGet, cacheVersion, loadCachedMeta } from './cache';
import type { LevelRule } from './logic';
import { isTemp, pathIds, resolveId, type Op } from './outbox';

/**
 * Base común del trabajo sin conexión: lo que se sabe de la última descarga (copia local) sobre lo que se le aplican, en orden,
 * las acciones pendientes. Aquí están los tipos, la sesión y la lectura de la copia local; las reglas de cada tema (lotes,
 * pedidos, clientes, activos, ubicaciones) están en `reduce.ts` y `domains/`.
 */

export type Any = any;
export const DELETED = 'deleted' as const;

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const subset = (small: Record<string, unknown>, big: Record<string, unknown>) => Object.entries(small).every(([k, v]) => same(big[k], v));
export const cleanSerial = (s: unknown): string | null => { const v = typeof s === 'string' ? s.trim() : ''; return v ? v.slice(0, 100) : null; };
export const iso = (t: number) => new Date(t).toISOString();
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
/** Datos técnicos como los guarda el servidor: sin valores vacíos. */
export const cleanSpecs = (specs: Any): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(specs ?? {})) if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out;
};
/** Texto opcional como lo guarda el servidor: vacío = nada. */
export const clean = (s: unknown, max: number): string | null => { const v = typeof s === 'string' ? s.trim() : ''; return v === '' ? null : v.slice(0, max); };

export function mergeSpecs(base: Any, patch: Any): Any {
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch ?? {})) { if (v === null || v === '') delete out[k]; else out[k] = v; }
  return out;
}

// ---------------------------------------------------------------- sesión (quién trabaja y qué puede ver)

export interface OverlaySession {
  techNumber: number;
  fullName: string;
  can: (permission: string) => boolean;
}
let session: OverlaySession = { techNumber: 0, fullName: '', can: () => false };
export const setOverlaySession = (s: OverlaySession) => { session = s; };
export const overlaySession = (): OverlaySession => session;

// ---------------------------------------------------------------- modelos de pedido

export interface OrderItem {
  id: number; unitId: number; unitPrice: number | null; lineId: number | null; matchStatus: string | null;
  /** Lo último que se supo del equipo (por si no está en la copia local de equipos). */
  snap: Any;
}
export interface OrderLineModel {
  id: number; lineNo: number; equipmentTypeId: number; specs: Record<string, unknown>; cosmeticGradeIds: number[]; functionalGradeIds: number[];
  quantity: number; unitPrice: number | null; notes: string | null;
}
export interface OrderModel {
  id: number; code: string; statusKey: string; customerId: number | null; sellerId: number | null; notes: string | null;
  /** Datos del cliente y nombre del vendedor tal como se ven en el pedido. */
  customer: { name: string; address: string | null; phone: string | null; contact: string | null; country: string | null } | null; sellerName: string | null;
  reservedUntil: string | null; currency: string; isQuick: boolean; createdAt: string; completedAt: string | null; cancelledAt: string | null;
  shipping: Any; adjustments: { label: string; kind: 'percent' | 'amount'; value: number }[];
  lines: OrderLineModel[]; items: OrderItem[];
}

// ---------------------------------------------------------------- contexto (base de la copia local)

export interface SlotInfo {
  id: number; code: string; capacity: number; isActive: boolean; rackId: number | null; levelNo: number | null;
  areaId: number | null; order: number; rule: LevelRule | null; preferredTypes: number[];
}

export interface Ctx {
  meta: Any;
  items: Map<number, Any>;
  suppliers: Map<number, string>;
  baseLots: Map<number, Any>;
  baseUnits: Map<number, Any>;
  lotCodes: Map<number, string>;
  baseOrders: Map<number, Any>;
  baseAssets: Map<number, Any>;
  /** Clientes y vendedores de la copia local (nombre, dirección…). */
  customers: Map<number, Any>;
  sellers: Map<number, Any>;
  slots: Map<number, SlotInfo>;
}

export interface State {
  lots: Map<number, Any>;          // detalle del lote con las acciones aplicadas ('deleted' si se eliminó)
  units: Map<number, Any>;         // equipo con las acciones aplicadas ('deleted' si se eliminó)
  createdLots: number[];
  createdUnits: number[];
  touchedLots: Set<number>;
  touchedUnits: Set<number>;
  orders: Map<number, OrderModel | typeof DELETED>;
  createdOrders: number[];
  touchedOrders: Set<number>;
  /** Clientes/vendedores/proveedores: filas nuevas y cambios sobre las existentes (clave "customers:12"). */
  partnersCreated: Record<string, Any[]>;
  partnerPatches: Map<string, Any>;
  assets: Map<number, Any>;        // activo con las acciones aplicadas ('deleted' si se eliminó)
  createdAssets: number[];
  touchedAssets: Set<number>;
  /** Datos extra que cada acción devuelve como respuesta (por número de acción): cuántos se cambiaron, avisos… */
  results: Map<number, Any>;
}

/** Lo que necesitan las reglas de cada tema para leer y cambiar equipos, lotes y pedidos "en trabajo" (copia de la base + acciones ya aplicadas). */
export interface Env {
  c: Ctx;
  st: State;
  unit(id: number): Any | null;
  lot(id: number): Any | null;
  order(id: number): OrderModel | null;
}

export const newState = (): State => ({
  lots: new Map(), units: new Map(), createdLots: [], createdUnits: [], touchedLots: new Set(), touchedUnits: new Set(),
  orders: new Map(), createdOrders: [], touchedOrders: new Set(),
  partnersCreated: {}, partnerPatches: new Map(),
  assets: new Map(), createdAssets: [], touchedAssets: new Set(), results: new Map(),
});

export const sysId = (c: Ctx, cat: string, key: string): number =>
  c.meta?.catalogs?.find((x: Any) => x.key === cat)?.items?.find((i: Any) => i.systemKey === key)?.id ?? 0;
export const sysKeyOf = (c: Ctx, id: number | null | undefined): string | null => (id ? c.items.get(id)?.systemKey ?? null : null);

// ---------------------------------------------------------------- lectura de la copia local

/** Todas las filas de los listados guardados cuya ruta empieza con `prefix` (sin repetir; gana la más reciente). */
let rowsMemo = new Map<string, { v: number; rows: Map<number, Any> }>();
export async function collectRows(prefix: string, exact?: string): Promise<Map<number, Any>> {
  const key = `${prefix}|${exact ?? ''}`;
  const v = cacheVersion();
  const hit = rowsMemo.get(key);
  if (hit && hit.v === v) return hit.rows;
  const rows = new Map<number, { at: number; row: Any }>();
  for (const e of await cacheEntries(prefix)) {
    const base = e.path.split('?')[0];
    if (exact && base !== exact) continue;
    if (!Array.isArray(e.data?.items)) continue;
    for (const r of e.data.items) {
      if (r && typeof r.id === 'number') { const cur = rows.get(r.id); if (!cur || e.at >= cur.at) rows.set(r.id, { at: e.at, row: r }); }
    }
  }
  const out = new Map<number, Any>();
  for (const [id, x] of rows) out.set(id, x.row);
  rowsMemo.set(key, { v, rows: out });
  if (rowsMemo.size > 40) rowsMemo = new Map([...rowsMemo].slice(-20));
  return out;
}

/** Todos los equipos que hay en la copia local (listas y fichas). */
let unitMemo: { v: number; units: Map<number, Any> } | null = null;
export async function scanUnits(): Promise<Map<number, Any>> {
  const v = cacheVersion();
  if (unitMemo && unitMemo.v === v) return unitMemo.units;
  const best = new Map<number, { at: number; u: Any }>();
  for (const e of await cacheEntries('/units')) {
    const one = /^\/units\/-?\d+$/.test(e.path);
    const list = one ? [e.data] : Array.isArray(e.data?.items) ? e.data.items : [];
    if (e.path.startsWith('/units/lookup')) continue;
    for (const u of list) if (u && typeof u.id === 'number') { const cur = best.get(u.id); if (!cur || e.at >= cur.at) best.set(u.id, { at: e.at, u }); }
  }
  const units = new Map<number, Any>();
  for (const [id, x] of best) units.set(id, x.u);
  unitMemo = { v, units };
  return units;
}
export function forgetScan() { unitMemo = null; rowsMemo = new Map(); }

/** Espacios del almacén (código, capacidad, regla del nivel, si están activos) a partir del árbol guardado. */
export function slotsFromTree(tree: Any): Map<number, SlotInfo> {
  const out = new Map<number, SlotInfo>();
  let order = 0;
  for (const w of tree?.warehouses ?? []) for (const a of w.areas ?? []) for (const r of a.racks ?? []) for (const lv of r.levels ?? []) for (const s of lv.slots ?? []) {
    out.set(s.id, {
      id: s.id, code: s.code, capacity: s.capacity, isActive: !!(w.isActive && a.isActive && r.isActive && s.isActive), rackId: r.id, levelNo: lv.levelNo,
      areaId: a.id, order: order++, rule: lv.rule ?? null, preferredTypes: a.preferredTypeIds ?? [],
    });
  }
  return out;
}
async function loadSlots(): Promise<Map<number, SlotInfo>> {
  const out = slotsFromTree((await cacheGet('/locations/tree'))?.data);
  if (!out.size) {
    let order = 0;
    for (const s of (await collectRows('/locations/slots')).values()) out.set(s.id, { id: s.id, code: s.code, capacity: s.capacity, isActive: true, rackId: s.rackId ?? null, levelNo: s.levelNo ?? null, areaId: s.areaId ?? null, order: order++, rule: null, preferredTypes: [] });
  }
  return out;
}

// ---------------------------------------------------------------- qué toca cada acción

const bodyOf = (o: Op): Any => o.body ?? {};

/** Equipos (reales) a los que se refiere una acción. */
export function unitIdsOf(o: Op): number[] {
  const b = bodyOf(o);
  switch (o.kind) {
    case 'unit.finish': case 'unit.update': case 'unit.delete': case 'unit.status': return [pathIds(o.path)[0]];
    case 'unit.costs': case 'unit.prices': case 'loc.unassign': case 'quick.sale': return b.unitIds ?? [];
    case 'loc.assign': return (b.assignments ?? []).map((a: Any) => a.unitId);
    case 'order.items': return b.unitIds ?? [];
    case 'order.create': return b.fromUnitIds ?? [];
    default: return [];
  }
}
/** Pedidos (reales) a los que se refiere una acción. */
export function orderIdsOf(o: Op): number[] {
  return o.kind.startsWith('order.') && o.kind !== 'order.create' ? [pathIds(o.path)[0]] : [];
}

export interface CtxExtra { lots?: number[]; units?: number[]; orders?: number[]; slots?: boolean; partners?: boolean }

export async function makeCtx(ops: Op[], extra: CtxExtra = {}): Promise<Ctx> {
  const meta = await loadCachedMeta();
  const items = new Map<number, Any>();
  for (const c of meta?.catalogs ?? []) for (const i of c.items) items.set(i.id, i);
  const suppliers = new Map<number, string>();
  for (const s of (await collectRows('/suppliers')).values()) suppliers.set(s.id, s.name);

  const needsPartners = !!extra.partners || ops.some((o) => o.kind.startsWith('order.') || o.kind === 'quick.sale') || !!extra.orders?.length;
  const customers = needsPartners ? await collectRows('/customers') : new Map<number, Any>();
  const sellers = needsPartners ? await collectRows('/sellers') : new Map<number, Any>();

  // pedidos reales tocados
  const baseOrders = new Map<number, Any>();
  for (const id of new Set([...ops.flatMap(orderIdsOf), ...(extra.orders ?? [])].map(resolveId).filter((n) => !isTemp(n)))) {
    const hit = await cacheGet(`/orders/${id}`);
    if (hit) baseOrders.set(id, hit.data);
  }

  // equipos reales tocados (por acciones de equipo, de pedido, de ubicación…)
  const baseUnits = new Map<number, Any>();
  const needUnits = new Set<number>([...ops.flatMap(unitIdsOf), ...(extra.units ?? [])].map(resolveId).filter((id) => !isTemp(id)));
  const completing = ops.some((o) => o.kind === 'order.complete' || o.kind === 'order.cancel' || o.kind === 'order.items_remove');
  if (completing) for (const d of baseOrders.values()) for (const i of d.items ?? []) needUnits.add(i.unitId);
  if (needUnits.size) {
    const all = await scanUnits();
    for (const id of needUnits) {
      const hit = all.get(id) ?? (await cacheGet(`/units/${id}`))?.data;
      if (hit) baseUnits.set(id, hit);
    }
  }

  // lotes reales tocados (por acciones de lote, de equipo o de línea)
  const lotIds = new Set<number>((extra.lots ?? []).map(resolveId));
  for (const o of ops) {
    if ((o.kind.startsWith('lot.') || o.kind.startsWith('line.')) && o.kind !== 'lot.create') lotIds.add(resolveId(pathIds(o.path)[0]));
    if (o.kind === 'unit.create') lotIds.add(resolveId(pathIds(o.path)[0]));
  }
  for (const u of baseUnits.values()) lotIds.add(u.lotId);
  const baseLots = new Map<number, Any>();
  const lotCodes = new Map<number, string>();
  for (const id of lotIds) {
    if (isTemp(id)) continue;
    const hit = await cacheGet(`/lots/${id}`);
    if (hit) { baseLots.set(id, hit.data); lotCodes.set(id, hit.data.code); }
  }
  if ([...lotIds].some((id) => !lotCodes.has(id) && !isTemp(id)) || ops.some((o) => o.kind === 'order.items' || o.kind === 'quick.sale')) {
    for (const l of (await collectRows('/lots')).values()) if (!lotCodes.has(l.id)) lotCodes.set(l.id, l.code);
  }
  const baseAssets = new Map<number, Any>();
  const assetIds = new Set(ops.filter((o) => o.kind === 'asset.update' || o.kind === 'asset.delete').map((o) => resolveId(pathIds(o.path)[0])).filter((n) => !isTemp(n)));
  if (assetIds.size) {
    const rows = await collectRows('/assets');
    for (const id of assetIds) {
      const hit = (await cacheGet(`/assets/${id}`))?.data ?? rows.get(id);
      if (hit) baseAssets.set(id, hit);
    }
  }
  const needsSlots = !!extra.slots || ops.some((o) => o.kind === 'loc.assign' || o.kind === 'loc.unassign');
  const slots = needsSlots ? await loadSlots() : new Map<number, SlotInfo>();
  return { meta, items, suppliers, baseLots, baseUnits, lotCodes, baseOrders, baseAssets, customers, sellers, slots };
}

export { loadSlots };
