import { useSyncExternalStore } from 'react';
import { idb, kv } from './idb';

/**
 * Cola de acciones hechas sin conexión (bandeja de salida). Cada acción es una petición HTTP guardada tal cual, con una llave
 * única (Idempotency-Key) para que el servidor nunca la ejecute dos veces aunque el envío se corte a la mitad.
 *
 * Se pueden guardar las acciones del trabajo diario: lotes, testeo, ubicaciones, pedidos y venta rápida, clientes/vendedores/
 * proveedores y activos. La configuración de la empresa (usuarios, roles, tipos de equipo, reportes…) requiere conexión.
 */
export type OpKind =
  | 'lot.create' | 'lot.update' | 'lot.delete' | 'lot.counts' | 'lot.transition'
  | 'line.add' | 'line.update' | 'line.delete' | 'line.unexpected'
  | 'unit.create' | 'unit.finish' | 'unit.update' | 'unit.delete'
  | 'unit.status' | 'unit.costs' | 'unit.prices'
  | 'loc.assign' | 'loc.unassign'
  | 'catalog.item'
  | 'partner.create' | 'partner.update'
  | 'asset.create' | 'asset.update' | 'asset.delete'
  | 'order.create' | 'order.update' | 'order.shipping' | 'order.items' | 'order.items_remove' | 'order.prices' | 'order.adjustments'
  | 'order.line_add' | 'order.line_update' | 'order.line_delete' | 'order.complete' | 'order.cancel'
  | 'quick.sale'
  /** Solo para reconocer la petición: al guardarse se convierten en `order.items` con los equipos ya elegidos. */
  | 'order.items_auto' | 'order.line_fill' | 'order.pick';

export type Method = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface OpError { status: number; code: string; params: Record<string, any> }

export interface Op {
  seq: number;
  scope: string;
  key: string;
  kind: OpKind;
  method: Method;
  path: string;
  body?: any;
  state: 'pending' | 'failed';
  attempts: number;
  error?: OpError;
  created: number;
  /** Ids provisionales que esta acción crea (los reales llegan al sincronizar). */
  temp?: Temp;
}

export interface Temp {
  lot?: number; lines?: number[]; line?: number; unit?: number; item?: number; code?: string;
  /** Pedido nuevo, sus líneas, una línea nueva, los renglones (equipos) que agrega y a qué equipo corresponde cada renglón. */
  order?: number; orderLines?: number[]; orderLine?: number; saleItems?: number[]; itemUnits?: number[];
  /** Cliente/vendedor/proveedor nuevo. */
  partner?: number;
  /** Activos nuevos y sus códigos provisionales. */
  assets?: number[]; codes?: string[];
  /** Líneas que se crean junto con un pedido abierto desde equipos ya escogidos (se calculan al guardar la acción). */
  plan?: { groups: any[] };
}

/** Todos los ids provisionales que una acción crea. */
export function tempIdsOf(t: Temp | undefined): number[] {
  if (!t) return [];
  return [t.lot, t.line, t.unit, t.item, t.order, t.orderLine, t.partner, ...(t.lines ?? []), ...(t.orderLines ?? []), ...(t.saleItems ?? []), ...(t.assets ?? [])]
    .filter((x): x is number => typeof x === 'number');
}

/** Los ids provisionales son números negativos muy grandes: no se confunden con datos reales ni con cantidades. */
export const TEMP_BASE = 2_000_000_000;
export const isTemp = (n: unknown): n is number => typeof n === 'number' && n <= -TEMP_BASE;

const RULES: [OpKind, Method, RegExp][] = [
  ['lot.create', 'POST', /^\/lots$/],
  ['lot.update', 'PATCH', /^\/lots\/(-?\d+)$/],
  ['lot.delete', 'DELETE', /^\/lots\/(-?\d+)$/],
  ['line.add', 'POST', /^\/lots\/(-?\d+)\/lines$/],
  ['line.update', 'PUT', /^\/lots\/(-?\d+)\/lines\/(-?\d+)$/],
  ['line.delete', 'DELETE', /^\/lots\/(-?\d+)\/lines\/(-?\d+)$/],
  ['lot.counts', 'PUT', /^\/lots\/(-?\d+)\/counts$/],
  ['line.unexpected', 'POST', /^\/lots\/(-?\d+)\/unexpected-lines$/],
  ['lot.transition', 'POST', /^\/lots\/(-?\d+)\/transition$/],
  ['unit.create', 'POST', /^\/lots\/(-?\d+)\/units$/],
  ['unit.finish', 'POST', /^\/units\/(-?\d+)\/finish-test$/],
  ['unit.update', 'PATCH', /^\/units\/(-?\d+)$/],
  ['unit.delete', 'DELETE', /^\/units\/(-?\d+)$/],
  ['unit.status', 'POST', /^\/units\/(-?\d+)\/status$/],
  ['unit.costs', 'POST', /^\/units\/costs$/],
  ['unit.prices', 'POST', /^\/units\/prices$/],
  ['loc.assign', 'POST', /^\/locations\/assign$/],
  ['loc.unassign', 'POST', /^\/locations\/unassign$/],
  ['catalog.item', 'POST', /^\/catalogs\/(\d+)\/quick-item$/],
  ['partner.create', 'POST', /^\/(customers|sellers|suppliers)$/],
  ['partner.update', 'PUT', /^\/(customers|sellers|suppliers)\/(-?\d+)$/],
  ['asset.create', 'POST', /^\/assets$/],
  ['asset.update', 'PATCH', /^\/assets\/(-?\d+)$/],
  ['asset.delete', 'DELETE', /^\/assets\/(-?\d+)$/],
  ['order.create', 'POST', /^\/orders$/],
  ['order.update', 'PATCH', /^\/orders\/(-?\d+)$/],
  ['order.shipping', 'PUT', /^\/orders\/(-?\d+)\/shipping$/],
  ['order.items', 'POST', /^\/orders\/(-?\d+)\/items$/],
  ['order.items_auto', 'POST', /^\/orders\/(-?\d+)\/items\/auto$/],
  ['order.items_remove', 'POST', /^\/orders\/(-?\d+)\/items\/remove$/],
  ['order.prices', 'POST', /^\/orders\/(-?\d+)\/prices$/],
  ['order.adjustments', 'PUT', /^\/orders\/(-?\d+)\/adjustments$/],
  ['order.line_add', 'POST', /^\/orders\/(-?\d+)\/lines$/],
  ['order.line_update', 'PUT', /^\/orders\/(-?\d+)\/lines\/(-?\d+)$/],
  ['order.line_delete', 'DELETE', /^\/orders\/(-?\d+)\/lines\/(-?\d+)$/],
  ['order.line_fill', 'POST', /^\/orders\/(-?\d+)\/lines\/(-?\d+)\/fill$/],
  ['order.pick', 'POST', /^\/orders\/(-?\d+)\/pick$/],
  ['order.complete', 'POST', /^\/orders\/(-?\d+)\/complete$/],
  ['order.cancel', 'POST', /^\/orders\/(-?\d+)\/cancel$/],
  ['quick.sale', 'POST', /^\/quick-sales$/],
];

/** ¿Esta petición se puede guardar para enviarla después? */
export function classify(method: string, path: string): OpKind | null {
  const p = path.split('?')[0];
  for (const [kind, m, re] of RULES) if (m === method && re.test(p)) return kind;
  return null;
}

/** Ids numéricos que aparecen en la ruta, en orden. */
export function pathIds(path: string): number[] {
  return (path.split('?')[0].match(/-?\d+/g) ?? []).map(Number);
}

/** Todos los ids provisionales que una acción usa (en su ruta o su contenido). */
export function tempRefs(path: string, body: unknown): number[] {
  const out = new Set<number>();
  for (const n of pathIds(path)) if (isTemp(n)) out.add(n);
  const walk = (v: unknown) => {
    if (typeof v === 'number') { if (isTemp(v)) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(body);
  return [...out];
}

/** Reemplaza ids provisionales por los reales (ruta y contenido). */
export function substitute<T>(v: T, map: Map<number, number>): T {
  if (typeof v === 'string') {
    return v.replace(/-\d{10,}/g, (m) => { const r = map.get(Number(m)); return r === undefined ? m : String(r); }) as unknown as T;
  }
  if (typeof v === 'number') return (isTemp(v) && map.has(v) ? map.get(v)! : v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => substitute(x, map)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, map)])) as T;
  return v;
}

// ---------------- estado en memoria (espejo de la base del navegador) ----------------

let scope: string | null = null;
let ops: Op[] = [];
let idMap = new Map<number, number>();
let tempSeq = 0;
let loaded: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();
let snapshot: Op[] = [];

let channel: BroadcastChannel | null = null;
try { channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('refurbiz-outbox') : null; } catch { channel = null; }

let version = 0;
/** Sube cada vez que cambia la bandeja (para no recalcular lo pendiente si no cambió nada). */
export const outboxVersion = () => version;

function emit(broadcast = true) {
  version++;
  snapshot = ops.slice();
  listeners.forEach((l) => l());
  if (broadcast) try { channel?.postMessage({ scope }); } catch { /* */ }
}

/** Otra pestaña cambió la bandeja: se vuelve a leer de la base del navegador. */
async function reloadFromDisk() {
  const s = scope;
  if (!s) return;
  const all = await idb.getAll<Op>('outbox');
  if (scope !== s) return;
  ops = all.filter((o) => o.scope === s).sort((a, b) => a.seq - b.seq);
  const saved = await kv.get<{ map: [number, number][]; seq: number }>(`ids:${s}`);
  if (scope !== s) return;
  if (saved) { for (const [t, r] of saved.map) idMap.set(t, r); tempSeq = Math.max(tempSeq, saved.seq); }
  emit(false);
}
if (channel) channel.onmessage = (e) => { if (e.data?.scope === scope) void reloadFromDisk(); };

/** Cambia de usuario/empresa: carga su cola pendiente. */
export function setOutboxScope(s: string | null): Promise<void> {
  scope = s;
  ops = []; idMap = new Map(); tempSeq = 0;
  emit();
  if (!s) { loaded = Promise.resolve(); return loaded; }
  loaded = (async () => {
    const all = await idb.getAll<Op>('outbox');
    if (scope !== s) return;
    ops = all.filter((o) => o.scope === s).sort((a, b) => a.seq - b.seq);
    const saved = await kv.get<{ map: [number, number][]; seq: number }>(`ids:${s}`);
    if (scope !== s) return;
    idMap = new Map(saved?.map ?? []);
    tempSeq = Math.max(saved?.seq ?? 0, 0);
    emit();
  })();
  return loaded;
}
export const outboxReady = () => loaded;

const saveIds = () => { if (scope) void kv.set(`ids:${scope}`, { map: [...idMap.entries()].slice(-2000), seq: tempSeq }); };

export function newTempId(): number { tempSeq++; saveIds(); return -(TEMP_BASE + tempSeq); }
/** Número que acompaña al código provisional ("PEND-3"). */
export function tempNumber(id: number): number { return -id - TEMP_BASE; }

export const listOps = (): Op[] => ops;
export const pendingCount = (): number => ops.filter((o) => o.state === 'pending').length;
export const failedCount = (): number => ops.filter((o) => o.state === 'failed').length;
export const hasActive = (): boolean => ops.some((o) => o.state === 'pending');

export function resolveId(id: number): number { return isTemp(id) ? idMap.get(id) ?? id : id; }
export const idMapping = (): Map<number, number> => idMap;
/** ¿Existe (sigue pendiente) la acción que crea este id provisional? */
export const creatorOf = (id: number): Op | undefined => ops.find((o) => tempIdsOf(o.temp).includes(id));

export function recordIds(pairs: [number, number][]) {
  for (const [t, r] of pairs) idMap.set(t, r);
  saveIds();
}

export async function addOp(o: Omit<Op, 'seq' | 'scope' | 'state' | 'attempts' | 'created'>): Promise<Op> {
  if (!scope) throw new Error('sin sesión');
  const op = await idb.put('outbox', { ...o, scope, state: 'pending', attempts: 0, created: Date.now() } as Op);
  ops.push(op);
  emit();
  return op;
}

export async function updateOp(seq: number, patch: Partial<Op>): Promise<void> {
  const op = ops.find((o) => o.seq === seq);
  if (!op) return;
  Object.assign(op, patch);
  await idb.put('outbox', op);
  emit();
}

export async function removeOps(seqs: number[]): Promise<void> {
  const set = new Set(seqs);
  ops = ops.filter((o) => !set.has(o.seq));
  for (const s of seqs) await idb.delete('outbox', s);
  emit();
}

/** Acciones que dependen (directa o indirectamente) de los ids provisionales que crea `op`. */
export function dependentsOf(op: Op): Op[] {
  const created = new Set<number>();
  const collect = (o: Op) => { tempIdsOf(o.temp).forEach((x) => created.add(x)); };
  collect(op);
  const out: Op[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const o of ops) {
      if (o.seq === op.seq || out.includes(o)) continue;
      if (tempRefs(o.path, o.body).some((r) => created.has(r))) { out.push(o); collect(o); grew = true; }
    }
  }
  return out;
}

/** ¿Una acción está esperando a otra (usa ids que aún no existen en el servidor)? */
export function waitingFor(op: Op): Op | undefined {
  for (const r of tempRefs(op.path, op.body)) {
    if (idMap.has(r)) continue;
    const c = creatorOf(r);
    if (c && c.seq !== op.seq) return c;
  }
  return undefined;
}

/** Cambios de la bandeja para pantallas (useSyncExternalStore). */
export function useOps(): Op[] {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => snapshot, () => snapshot);
}
export function subscribeOps(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Cambio de estado de sincronización (para el chip y la pantalla de pendientes). */
export const newKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);
