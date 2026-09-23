import { ApiError } from '../../apiError';
import { pathIds, resolveId, type Op } from '../outbox';
import { clean, iso, type Any, type Ctx, type State } from '../state';

/** Clientes, vendedores y proveedores: listas simples con alta y edición (no se borran). */

interface Def { fields: { key: string; max?: number; id?: boolean }[]; search: string[] }
const T = (key: string, max = 200) => ({ key, max });
const I = (key: string) => ({ key, id: true });

export const PARTNERS: Record<string, Def> = {
  suppliers: { fields: [T('name', 160), T('contactName'), T('email'), T('phone', 50), T('country', 80), T('address', 300), T('notes', 1000)], search: ['name', 'contactName', 'email'] },
  customers: { fields: [T('name', 160), I('customerTypeId'), T('contactName'), T('email'), T('phone', 50), T('country', 80), T('address', 300), T('taxId', 50), T('notes', 1000)], search: ['name', 'contactName', 'email', 'country'] },
  sellers: { fields: [T('name', 160), T('email'), T('phone', 50), I('membershipId')], search: ['name', 'email'] },
};
export type PartnerKind = 'suppliers' | 'customers' | 'sellers';

export const partnerKindOf = (path: string): PartnerKind | null => (path.split('?')[0].match(/^\/(customers|sellers|suppliers)(\/|$)/)?.[1] as PartnerKind | undefined) ?? null;

/** Los campos del cuerpo tal como los guarda el servidor (vacío = nada). */
function cleanFields(kind: PartnerKind, body: Any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of PARTNERS[kind].fields) {
    const v = body?.[f.key];
    out[f.key] = f.id ? (typeof v === 'number' ? v : null) : clean(v, f.max ?? 200);
  }
  return out;
}

export function validatePartner(o: Pick<Op, 'body'>, kind: PartnerKind) {
  if (!clean(o.body?.name, 160)) throw new ApiError(400, 'validation', { message: 'name', field: '' });
  void kind;
}

export function applyPartnerOp(o: Op, st: State) {
  const kind = partnerKindOf(o.path);
  if (!kind) return;
  const b = o.body ?? {};
  if (o.kind === 'partner.create') {
    const row = { id: o.temp!.partner!, ...cleanFields(kind, b), isActive: true, createdAt: iso(o.created), pendingSync: true };
    (st.partnersCreated[kind] ??= []).push(row);
    return;
  }
  // partner.update (PUT: reemplaza todos los datos; "activo" solo cambia si se indica)
  const id = resolveId(pathIds(o.path)[0]);
  const patch = { ...cleanFields(kind, b), ...(typeof b.isActive === 'boolean' ? { isActive: b.isActive } : {}), pendingSync: true };
  const made = (st.partnersCreated[kind] ?? []).find((r) => r.id === id);
  if (made) Object.assign(made, patch);
  else st.partnerPatches.set(`${kind}:${id}`, { ...(st.partnerPatches.get(`${kind}:${id}`) ?? {}), ...patch });
}

const norm = (s: unknown) => String(s ?? '').toLowerCase();

/** Aplica lo pendiente a una lista (mismos filtros del servidor: activos y búsqueda; orden por nombre). */
export function overlayPartnerList(kind: PartnerKind, path: string, data: Any, st: State): Any {
  const created = st.partnersCreated[kind] ?? [];
  const patched = (data.items as Any[]).some((r) => st.partnerPatches.has(`${kind}:${r.id}`));
  if (!created.length && !patched) return data;
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  const active = q.get('active') ?? 'true';
  const term = norm(q.get('q'));
  const keep = (r: Any) => {
    if (active !== 'all' && !!r.isActive !== (active === 'true')) return false;
    if (term && !PARTNERS[kind].search.some((k) => norm(r[k]).includes(term))) return false;
    return true;
  };
  const rows = (data.items as Any[]).map((r) => { const p = st.partnerPatches.get(`${kind}:${r.id}`); return p ? { ...r, ...p } : r; });
  const merged = [...rows, ...created].filter(keep).sort((a, b) => norm(a.name).localeCompare(norm(b.name)));
  const complete = data.total <= data.items.length;
  return { ...data, items: merged, total: complete ? merged.length : data.total + created.filter(keep).length };
}

export function overlayPartnerDetail(kind: PartnerKind, id: number, data: Any, st: State): Any {
  const made = (st.partnersCreated[kind] ?? []).find((r) => r.id === id);
  if (made) return made;
  const p = st.partnerPatches.get(`${kind}:${id}`);
  return p ? { ...data, ...p } : data;
}

export function respondPartner(o: Op, st: State): Any {
  const kind = partnerKindOf(o.path)!;
  if (o.kind === 'partner.create') return { id: o.temp!.partner, pendingSync: true };
  return { id: resolveId(pathIds(o.path)[0]), pendingSync: true, kind };
}

/** Un cliente o vendedor tal como se ve ahora: el recién creado sin conexión, o el de la copia local con lo pendiente aplicado. */
export function partnerRow(st: State, c: Ctx, kind: 'customers' | 'sellers', id: number): Any | null {
  const made = (st.partnersCreated[kind] ?? []).find((r) => r.id === id);
  if (made) return made;
  const base = (kind === 'customers' ? c.customers : c.sellers).get(id);
  if (!base) return null;
  const patch = st.partnerPatches.get(`${kind}:${id}`);
  return patch ? { ...base, ...patch } : base;
}
