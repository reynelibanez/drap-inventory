import { ApiError } from '../../apiError';
import { pathIds, resolveId, type Op } from '../outbox';
import { clean, cleanSpecs, clone, collectRows, DELETED, iso, mergeSpecs, overlaySession, subset, sysId, sysKeyOf, type Any, type Ctx, type State } from '../state';
import { loadCachedMeta } from '../cache';

/** Activos de la empresa (herramientas y equipos propios): alta de uno o varios iguales, edición y baja. */

export function newAsset(o: Op, i: number, c: Ctx): Any {
  const b = o.body ?? {};
  const statusId = b.statusId ?? sysId(c, 'asset_status', 'in_use');
  return {
    id: o.temp!.assets![i], code: o.temp!.codes![i], name: clean(b.name, 150), serialNumber: clean(b.serialNumber, 100), specs: cleanSpecs(b.specs),
    notes: clean(b.notes, 1000), equipmentTypeId: b.equipmentTypeId, statusId, statusKey: sysKeyOf(c, statusId) ?? 'in_use',
    assignedTo: clean(b.assignedTo, 150), location: clean(b.location, 150), acquiredAt: b.acquiredAt ?? null,
    createdAt: iso(o.created), updatedAt: iso(o.created), createdByName: overlaySession().fullName || null, pendingSync: true,
  };
}

export function applyAssetOp(o: Op, c: Ctx, st: State) {
  const b = o.body ?? {};
  if (o.kind === 'asset.create') {
    for (let i = 0; i < o.temp!.assets!.length; i++) {
      const a = newAsset(o, i, c);
      st.assets.set(a.id, a); st.createdAssets.push(a.id); st.touchedAssets.add(a.id);
    }
    return;
  }
  const id = resolveId(pathIds(o.path)[0]);
  if (o.kind === 'asset.delete') { st.assets.set(id, DELETED); st.touchedAssets.add(id); return; }
  let a: Any = st.assets.get(id);
  if (a === DELETED) return;
  if (!a) {
    const base = c.baseAssets.get(id);
    if (!base) return;
    a = clone(base); delete a.history;
    st.assets.set(id, a);
  }
  st.touchedAssets.add(id);
  // Cambiar el tipo reemplaza los datos técnicos (los atributos dependen del tipo).
  const typeChanged = !!b.equipmentTypeId && b.equipmentTypeId !== a.equipmentTypeId;
  if (typeChanged) { a.equipmentTypeId = b.equipmentTypeId; a.specs = {}; }
  if (b.specs || typeChanged) a.specs = cleanSpecs(mergeSpecs(a.specs, b.specs));
  if (b.serialNumber !== undefined) a.serialNumber = clean(b.serialNumber, 100);
  if (b.name !== undefined) a.name = clean(b.name, 150);
  if (b.assignedTo !== undefined) a.assignedTo = clean(b.assignedTo, 150);
  if (b.location !== undefined) a.location = clean(b.location, 150);
  if (b.acquiredAt !== undefined) a.acquiredAt = b.acquiredAt ?? null;
  if (b.notes !== undefined) a.notes = clean(b.notes, 1000);
  if (b.statusId) { a.statusId = b.statusId; a.statusKey = sysKeyOf(c, b.statusId) ?? a.statusKey; }
  a.updatedAt = iso(o.created);
  a.pendingSync = true;
}

/** Los mismos filtros del servidor para los listados de activos. */
export function matchesAsset(q: URLSearchParams, a: Any): boolean {
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : null);
  if (num('typeId') !== null && a.equipmentTypeId !== num('typeId')) return false;
  if (num('statusId') !== null && a.statusId !== num('statusId')) return false;
  if (q.get('statusKey') && a.statusKey !== q.get('statusKey')) return false;
  if (q.get('notStatusKey') && a.statusKey === q.get('notStatusKey')) return false;
  if (q.get('ids') && !q.get('ids')!.split(',').map(Number).includes(a.id)) return false;
  if (q.get('specs')) { try { if (!subset(JSON.parse(q.get('specs')!), a.specs ?? {})) return false; } catch { /* filtro inválido */ } }
  if (q.get('q')) {
    const t = q.get('q')!.toLowerCase();
    if (![a.code, a.name, a.serialNumber, a.assignedTo, a.location].some((x) => String(x ?? '').toLowerCase().includes(t))) return false;
  }
  return true;
}

export function sortAssets(rows: Any[], sort: string | null): Any[] {
  const out = [...rows];
  if (sort === 'oldest') out.sort((a, b) => a.id - b.id);
  else if (sort === 'code') out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  else out.sort((a, b) => b.id - a.id);
  return out;
}

export function overlayAssetList(path: string, data: Any, st: State): Any {
  if (!st.touchedAssets.size) return data;
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  const rows: Any[] = [];
  for (const r of data.items as Any[]) {
    const n = st.assets.get(r.id);
    if (n === DELETED) continue;
    if (n && st.touchedAssets.has(r.id)) { if (matchesAsset(q, n)) rows.push({ ...r, ...n }); continue; }
    rows.push(r);
  }
  const fresh: Any[] = [];
  for (const id of st.createdAssets) { const a = st.assets.get(id); if (a && a !== DELETED && matchesAsset(q, a)) fresh.push(a); }
  const sort = q.get('sort') ?? 'newest';
  const items = sort === 'oldest' ? [...rows, ...fresh] : sort === 'code' ? sortAssets([...rows, ...fresh], 'code') : [...fresh.reverse(), ...rows];
  return { ...data, items, total: Math.max(0, data.total + items.length - data.items.length) };
}

export function overlayAssetDetail(id: number, data: Any, st: State): Any {
  const a = st.assets.get(id);
  if (a === DELETED) throw new ApiError(404, 'asset_not_found');
  if (!a) return data;
  return { ...(data ?? {}), ...a, history: data?.history ?? [] };
}

export function respondAsset(o: Op, st: State): Any {
  if (o.kind === 'asset.create') return { items: o.temp!.assets!.map((id) => st.assets.get(id)), pendingSync: true };
  if (o.kind === 'asset.delete') return { ok: true, pendingSync: true };
  const a = st.assets.get(resolveId(pathIds(o.path)[0]));
  return a && a !== DELETED ? a : { ok: true, pendingSync: true };
}

/** Avisos que daría el servidor antes de guardar (tipo activo, serie repetida, cantidad con serie). */
export async function validateAsset(o: Pick<Op, 'body' | 'path'> & { kind: string }, st: State) {
  const b = o.body ?? {};
  const meta = await loadCachedMeta();
  if (o.kind === 'asset.create' || b.equipmentTypeId) {
    const type = meta?.equipmentTypes?.find((t: Any) => t.id === b.equipmentTypeId);
    if (meta && (!type || !type.isActive)) throw new ApiError(400, 'invalid_equipment_type');
  }
  if (o.kind === 'asset.create' && clean(b.serialNumber, 100) && (b.quantity ?? 1) > 1) throw new ApiError(400, 'asset_serial_single');
  const serial = b.serialNumber !== undefined ? clean(b.serialNumber, 100) : null;
  if (serial) {
    const except = o.kind === 'asset.update' ? resolveId(pathIds(o.path)[0]) : null;
    const low = serial.toLowerCase();
    const seen = new Set<number>();
    for (const [id, a] of st.assets) { seen.add(id); if (a !== DELETED && id !== except && (a.serialNumber ?? '').toLowerCase() === low) throw new ApiError(409, 'asset_serial_duplicate', { code: a.code, assetId: id }); }
    for (const a of (await collectRows('/assets')).values()) {
      if (seen.has(a.id) || a.id === except) continue;
      if ((a.serialNumber ?? '').toLowerCase() === low) throw new ApiError(409, 'asset_serial_duplicate', { code: a.code, assetId: a.id });
    }
  }
}
