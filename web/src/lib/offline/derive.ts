import { cacheEntries, cacheGet } from './cache';
import { matchesAsset, sortAssets } from './domains/assets';
import { PARTNERS, partnerKindOf, type PartnerKind } from './domains/partners';
import { lookupUnit } from './domains/orders';
import { slotsFromTreeList } from './domains/stock';
import { resolveId } from './outbox';
import { collectRows, scanUnits, subset, type Any } from './state';

/**
 * Lecturas sin conexión de algo que la pantalla pidió con una consulta distinta a las guardadas (otro filtro, otro orden, un equipo
 * suelto, una búsqueda). Se calculan con la misma regla del servidor a partir de un listado COMPLETO ya guardado (que cubra lo pedido):
 * si no hay uno completo no se inventa nada y la pantalla avisa que ese dato aún no se descargó.
 */

export const parseQuery = (path: string) => new URLSearchParams(path.split('?')[1] ?? '');
const norm = (v: unknown) => String(v ?? '').toLowerCase();

// ---------------------------------------------------------------- filtros (iguales a los del servidor)

export function matchesUnit(q: URLSearchParams, u: Any): boolean {
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
  const eq = (k: string, v: unknown, transform: (n: number) => number = (n) => n) => { const n = num(k); return n === null || transform(n) === v; };
  if (!eq('lotId', resolveId(u.lotId), resolveId)) return false;
  if (!eq('typeId', u.equipmentTypeId) || !eq('statusId', u.statusId) || !eq('testerNumber', u.testerNumber)) return false;
  if (!eq('cosmeticGradeId', u.cosmeticGradeId) || !eq('functionalGradeId', u.functionalGradeId) || !eq('slotId', u.slotId)) return false;
  if (q.get('statusKey') && u.statusKey !== q.get('statusKey')) return false;
  if (q.get('notStatusKey') && u.statusKey === q.get('notStatusKey')) return false;
  if (q.get('placed') === 'yes' && !u.slotId) return false;
  if (q.get('placed') === 'no' && u.slotId) return false;
  if (q.get('ids') && !q.get('ids')!.split(',').map(Number).includes(u.id)) return false;
  if (q.get('specs')) { try { if (!subset(JSON.parse(q.get('specs')!), u.specs ?? {})) return false; } catch { /* filtro inválido: lo ignora */ } }
  if (q.get('q')) {
    const t = q.get('q')!.toLowerCase();
    if (!`${u.code} ${u.serialNumber ?? ''}`.toLowerCase().includes(t)) return false;
  }
  return true;
}

export function matchesLot(q: URLSearchParams, r: Any): boolean {
  if (q.get('openOnly') && r.statusKey === 'closed') return false;
  if (q.get('statusId') && r.statusId !== Number(q.get('statusId'))) return false;
  if (q.get('supplierId') && r.supplierId !== Number(q.get('supplierId'))) return false;
  if (q.get('q') && !`${r.code} ${r.reference ?? ''} ${r.supplierName ?? ''}`.toLowerCase().includes(q.get('q')!.toLowerCase())) return false;
  return true;
}

export function matchesOrder(q: URLSearchParams, r: Any, m?: { customerId: number | null; sellerId: number | null } | null): boolean {
  if (q.get('statusKey') && r.statusKey !== q.get('statusKey')) return false;
  if (q.get('customerId') && m && m.customerId !== Number(q.get('customerId'))) return false;
  if (q.get('sellerId') && m && m.sellerId !== Number(q.get('sellerId'))) return false;
  if (q.get('q') && !`${r.code} ${r.customerName ?? ''}`.toLowerCase().includes(q.get('q')!.toLowerCase())) return false;
  return true;
}

export function matchesPartner(kind: PartnerKind, q: URLSearchParams, r: Any): boolean {
  const active = q.get('active') ?? 'true';
  if (active !== 'all' && !!r.isActive !== (active === 'true')) return false;
  const term = norm(q.get('q'));
  if (term && !PARTNERS[kind].search.some((k) => norm(r[k]).includes(term))) return false;
  return true;
}

const byDate = (a: Any, b: Any, key: string) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')) || b.id - a.id;
export const sortUnits = (rows: Any[], sort: string | null): Any[] => {
  const out = [...rows];
  if (sort === 'oldest') out.sort((a, b) => a.id - b.id);
  else if (sort === 'code') out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  else out.sort((a, b) => b.id - a.id);
  return out;
};

// ---------------------------------------------------------------- listados a partir de uno completo ya guardado

interface ListSpec {
  /** Parámetros que cambian qué filas salen (y este archivo sabe aplicar). */
  filters: string[];
  match: (q: URLSearchParams, r: Any) => boolean;
  order: (rows: Any[], q: URLSearchParams) => Any[];
  /** Valores que se asumen si el parámetro no viene (p. ej. `active=true` en clientes). */
  defaults?: Record<string, string>;
  /** El listado no se pagina cuando viene este parámetro (`?all=1`). */
  unpaged?: string;
}

const partnerSpec = (kind: PartnerKind): ListSpec => ({
  filters: ['active', 'q'], defaults: { active: 'true' }, unpaged: 'all',
  match: (q, r) => matchesPartner(kind, q, r),
  order: (rows) => [...rows].sort((a, b) => norm(a.name).localeCompare(norm(b.name))),
});

const SPECS: Record<string, ListSpec> = {
  '/units': { filters: ['q', 'lotId', 'typeId', 'statusId', 'statusKey', 'notStatusKey', 'testerNumber', 'cosmeticGradeId', 'functionalGradeId', 'slotId', 'placed', 'ids', 'specs'], match: matchesUnit, order: (rows, q) => sortUnits(rows, q.get('sort')) },
  '/lots': { filters: ['q', 'statusId', 'supplierId', 'openOnly'], match: matchesLot, order: (rows) => [...rows].sort((a, b) => byDate(a, b, 'createdAt')) },
  '/orders': { filters: ['q', 'statusKey'], match: (q, r) => matchesOrder(q, r), order: (rows) => [...rows].sort((a, b) => b.id - a.id) },
  '/assets': { filters: ['q', 'typeId', 'statusId', 'statusKey', 'notStatusKey', 'ids', 'specs'], match: matchesAsset, order: (rows, q) => sortAssets(rows, q.get('sort')) },
  '/customers': partnerSpec('customers'),
  '/sellers': partnerSpec('sellers'),
  '/suppliers': partnerSpec('suppliers'),
};
/** Filtros que el servidor acepta pero que no se pueden calcular con las filas del listado (no traen ese dato). */
const NOT_LOCAL: Record<string, string[]> = { '/orders': ['customerId', 'sellerId'] };
const PAGING = new Set(['page', 'pageSize', 'sort', 'all']);

const filterMap = (spec: ListSpec, base: string, q: URLSearchParams): Map<string, string> | null => {
  const out = new Map<string, string>();
  for (const [k, v] of q) {
    if (PAGING.has(k)) continue;
    if (!spec.filters.includes(k) && !(NOT_LOCAL[base] ?? []).includes(k)) return null;   // un parámetro que no se conoce: no se calcula
    if (v !== '') out.set(k, v);
  }
  for (const [k, v] of Object.entries(spec.defaults ?? {})) if (!out.has(k)) out.set(k, v);
  return out;
};

/** ¿El listado guardado tiene todas las filas que pide esta consulta? (sus filtros son los mismos o más amplios) */
const covers = (entry: Map<string, string>, want: Map<string, string>): boolean => {
  for (const [k, v] of entry) {
    if (k === 'active' && v === 'all') continue;
    if (want.get(k) !== v) return false;
  }
  return true;
};

export async function deriveList(path: string): Promise<Any | undefined> {
  const base = path.split('?')[0];
  const spec = SPECS[base];
  if (!spec) return undefined;
  const q = parseQuery(path);
  const want = filterMap(spec, base, q);
  if (!want) return undefined;

  // Un listado grande se guardó por páginas: se juntan las páginas de la misma consulta y solo sirve si quedó completo.
  const groups = new Map<string, { at: number; rows: Map<number, Any>; total: number; have: Map<string, string> }>();
  for (const e of await cacheEntries(base)) {
    if (e.path.split('?')[0] !== base || !Array.isArray(e.data?.items)) continue;
    const have = filterMap(spec, base, parseQuery(e.path));
    if (!have || !covers(have, want)) continue;
    const key = [...have].sort().map(([k, v]) => `${k}=${v}`).join('&');
    const g = groups.get(key) ?? { at: 0, rows: new Map<number, Any>(), total: 0, have };
    for (const r of e.data.items as Any[]) g.rows.set(r.id, r);
    g.total = Math.max(g.total, Number(e.data.total) || 0);
    g.at = Math.max(g.at, e.at);
    groups.set(key, g);
  }
  let best: { at: number; items: Any[]; have: Map<string, string> } | null = null;
  for (const g of groups.values()) {
    if (g.rows.size < g.total) continue;   // faltan filas: no se inventa
    if (!best || g.at > best.at) best = { at: g.at, items: [...g.rows.values()], have: g.have };
  }
  if (!best) return undefined;
  // Los filtros que el listado guardado no aplicó se calculan aquí; si alguno no se puede calcular, no se responde.
  for (const k of NOT_LOCAL[base] ?? []) if (want.get(k) !== best.have.get(k)) return undefined;
  const rows = spec.order(best.items.filter((r) => spec.match(q, r)), q);
  if (spec.unpaged && q.get(spec.unpaged)) return { items: rows, total: rows.length };
  const pageSize = Math.min(5000, Math.max(1, Number(q.get('pageSize')) || 50));
  const page = Math.max(1, Number(q.get('page')) || 1);
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

// ---------------------------------------------------------------- fichas y consultas sueltas

/** Copia de un equipo o activo a partir de los listados guardados. */
export async function deriveGet(path: string): Promise<Any | undefined> {
  const p = path.split('?')[0];
  const q = parseQuery(path);
  let m: RegExpMatchArray | null;

  const list = await deriveList(path);
  if (list) return list;

  if ((m = p.match(/^\/units\/(\d+)$/))) {
    const u = (await scanUnits()).get(Number(m[1]));
    return u ? { ...u, history: [] } : undefined;
  }
  if (p === '/units/batch') {
    const scan = await scanUnits();
    const ids = [...new Set((q.get('ids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    const items = ids.map((id) => scan.get(id));
    return items.every(Boolean) ? { items } : undefined;
  }
  if (p === '/units/lookup') {
    const u = lookupUnit(await scanUnits(), q.get('code') ?? '');
    return u ? { id: u.id } : undefined;
  }
  if ((m = p.match(/^\/assets\/(\d+)$/))) {
    const a = (await collectRows('/assets')).get(Number(m[1]));
    return a ? { ...a, history: [] } : undefined;
  }
  if (p === '/assets/batch') {
    const rows = await collectRows('/assets');
    const items = (q.get('ids') ?? '').split(',').map(Number).filter((n) => n > 0).map((id) => rows.get(id));
    return items.length && items.every(Boolean) ? { items } : undefined;
  }
  if (p === '/assets/lookup') {
    const t = norm(q.get('code')).trim();
    const hit = [...(await collectRows('/assets')).values()].find((a) => norm(a.code) === t || norm(a.serialNumber) === t);
    return hit ? { id: hit.id } : undefined;
  }
  const kind = partnerKindOf(p);
  if (kind && (m = p.match(/^\/[a-z]+\/(\d+)$/))) {
    const r = (await collectRows(`/${kind}`)).get(Number(m[1]));
    return r ?? undefined;
  }
  if (p === '/locations/slots') {
    const tree = (await cacheGet('/locations/tree'))?.data;
    return tree ? slotsFromTreeList(tree, path) : undefined;
  }
  return undefined;
}
