import { ApiError } from '../../apiError';
import { cacheGet } from '../cache';
import { ruleAllows, roundPrice, suggestPlacement, type PlaceableUnit, type Rounding, type SlotState, type Suggestion } from '../logic';
import { pathIds, resolveId, type Op } from '../outbox';
import { clone, DELETED, iso, scanUnits, slotsFromTree, sysKeyOf, type Any, type Ctx, type Env, type State } from '../state';

/**
 * Estado, costo, precio y ubicación de los equipos (lo que se cambia sin tocar su testeo).
 * Costos y precios trabajan solo con el equipo elegido; el reparto del costo del lote y las reglas de precio automáticas las
 * recalcula el servidor al sincronizar.
 */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function applyStockOp(o: Op, env: Env) {
  const { c, st } = env;
  const b = o.body ?? {};
  switch (o.kind) {
    case 'unit.status': {
      const u = env.unit(resolveId(pathIds(o.path)[0])); if (!u) break;
      u.statusId = b.statusId; u.statusKey = sysKeyOf(c, b.statusId) ?? u.statusKey; u.updatedAt = iso(o.created); u.pendingSync = true;
      st.touchedUnits.add(u.id);
      break;
    }
    case 'unit.costs': {
      let changed = 0;
      for (const id of new Set<number>(b.unitIds ?? [])) {
        const u = env.unit(resolveId(id)); if (!u) continue;
        const cost = b.mode === 'set' ? b.value : b.mode === 'pct' ? (u.cost ?? 0) * (1 + b.value / 100) : (u.cost ?? 0) + b.value;
        u.cost = Math.max(0, Math.round(cost * 10000) / 10000); u.costSource = 'manual'; u.pendingSync = true;
        st.touchedUnits.add(u.id); changed++;
      }
      st.results.set(o.seq, { ok: true, count: changed });
      break;
    }
    case 'unit.prices': {
      let changed = 0, skipped = 0;
      for (const id of new Set<number>(b.unitIds ?? [])) {
        const u = env.unit(resolveId(id)); if (!u) continue;
        let price: number | null;
        if (b.mode === 'clear') price = null;
        else if (b.mode === 'set') price = b.value;
        else if (b.mode === 'pct') price = u.listPrice == null ? null : u.listPrice * (1 + b.value / 100);
        else if (b.mode === 'add') price = u.listPrice == null ? null : u.listPrice + b.value;
        else price = u.cost == null ? null : u.cost / (1 - b.value / 100);
        if (price === null && b.mode !== 'clear') { skipped++; continue; }
        const final = price === null ? null : roundPrice(price, (b.rounding ?? 'none') as Rounding);
        u.listPrice = final; u.priceSource = final === null ? null : 'manual'; u.pendingSync = true;
        st.touchedUnits.add(u.id); changed++;
      }
      st.results.set(o.seq, { ok: true, changed, skipped });
      break;
    }
    case 'loc.assign': {
      const warnings: { unit: string; slot: string }[] = [];
      for (const a of b.assignments ?? []) {
        const u = env.unit(resolveId(a.unitId)); if (!u) continue;
        const s = c.slots.get(a.slotId);
        u.slotId = a.slotId; u.slotCode = s?.code ?? u.slotCode ?? null; u.pendingSync = true;
        st.touchedUnits.add(u.id);
        if (s && !ruleAllows(placeable(u), s.rule)) warnings.push({ unit: u.code, slot: s.code });
      }
      st.results.set(o.seq, { moved: (b.assignments ?? []).length, warnings });
      break;
    }
    case 'loc.unassign': {
      let removed = 0;
      for (const id of new Set<number>(b.unitIds ?? [])) {
        const u = env.unit(resolveId(id)); if (!u || !u.slotId) continue;
        u.slotId = null; u.slotCode = null; u.pendingSync = true; st.touchedUnits.add(u.id); removed++;
      }
      st.results.set(o.seq, { removed });
      break;
    }
  }
}

export function respondStock(o: Op, st: State): Any {
  if (o.kind === 'unit.status') {
    const u = st.units.get(resolveId(pathIds(o.path)[0]));
    return u && u !== DELETED ? { ...u, history: [] } : { ok: true, pendingSync: true };
  }
  return { ...(st.results.get(o.seq) ?? { ok: true }), pendingSync: true };
}

export const placeable = (u: Any): PlaceableUnit => ({ id: u.id, typeId: u.equipmentTypeId, specs: u.specs ?? {}, cosmeticGradeId: u.cosmeticGradeId ?? null, functionalGradeId: u.functionalGradeId ?? null });

/** Equipos de la copia local con las acciones aplicadas (para contar ocupación y disponibles). */
export async function liveUnits(st: State): Promise<Map<number, Any>> {
  const out = new Map<number, Any>(await scanUnits());
  for (const [id, u] of st.units) { if (u === DELETED) out.delete(id); else out.set(id, u); }
  return out;
}

// ---------------------------------------------------------------- validación previa

export async function validateStock(kind: Op['kind'], path: string, body: Any, env: Env): Promise<void> {
  const { c } = env;
  const known = (id: number) => env.unit(resolveId(id));
  if (kind === 'unit.status') {
    const u = known(pathIds(path)[0]);
    const target = c.items.get(body?.statusId);
    if (target && (target.systemKey === 'reserved' || target.systemKey === 'sold')) throw new ApiError(409, 'status_managed_by_sales');
    if (u && (u.statusKey === 'reserved' || u.statusKey === 'sold')) throw new ApiError(409, 'status_managed_by_sales');
    if (u && target?.systemKey === 'available' && !u.testedAt) throw new ApiError(409, 'unit_not_tested');
    return;
  }
  if (kind === 'unit.costs' || kind === 'unit.prices') {
    if (kind === 'unit.costs' && body?.mode === 'plan') throw new ApiError(0, 'offline_required');
    if (kind === 'unit.prices' && body?.mode === 'rules') throw new ApiError(0, 'offline_required');
    if (['set', 'pct', 'add', 'margin'].includes(body?.mode) && !isNum(body?.value)) throw new ApiError(400, 'invalid_value');
    if (body?.mode === 'set' && body.value < 0) throw new ApiError(400, 'invalid_value');
    if (kind === 'unit.prices' && body?.mode === 'margin' && body.value >= 100) throw new ApiError(400, 'invalid_value');
    for (const id of body?.unitIds ?? []) { const u = known(id); if (u?.statusKey === 'sold') throw new ApiError(409, 'unit_sold', { code: u.code }); }
    return;
  }
  if (kind === 'loc.assign') {
    const list: { unitId: number; slotId: number }[] = body?.assignments ?? [];
    const ids = list.map((a) => resolveId(a.unitId));
    if (new Set(ids).size !== ids.length) throw new ApiError(400, 'duplicate_unit');
    for (const a of list) { const u = known(a.unitId); if (u?.statusKey === 'sold') throw new ApiError(409, 'unit_sold', { code: u.code }); }
    if (!c.slots.size) return;   // sin copia de los espacios: lo decide el servidor al sincronizar
    const live = await liveUnits(env.st);
    const moving = new Set(ids);
    const used = new Map<number, number>();
    for (const u of live.values()) if (u.slotId && !moving.has(u.id)) used.set(u.slotId, (used.get(u.slotId) ?? 0) + 1);
    const incoming = new Map<number, number>();
    for (const a of list) {
      if (!c.slots.has(a.slotId)) throw new ApiError(400, 'invalid_slot');
      incoming.set(a.slotId, (incoming.get(a.slotId) ?? 0) + 1);
    }
    for (const [slotId, n] of incoming) {
      const s = c.slots.get(slotId)!;
      if (!s.isActive) throw new ApiError(409, 'slot_inactive', { slot: s.code });
      if ((used.get(slotId) ?? 0) + n > s.capacity) throw new ApiError(409, 'slot_full', { slot: s.code, capacity: s.capacity });
    }
  }
}

// ---------------------------------------------------------------- lectura: árbol, espacios y sugerencias

/** Cuántos equipos entran o salen de cada espacio por lo pendiente. */
function slotDeltas(st: State, c: Ctx): Map<number, number> {
  const d = new Map<number, number>();
  const bump = (id: number | null | undefined, n: number) => { if (id) d.set(id, (d.get(id) ?? 0) + n); };
  for (const id of st.touchedUnits) {
    const now = st.units.get(id);
    const before = c.baseUnits.get(id);
    if (now === DELETED) bump(before?.slotId, -1);
    else if (now) { if ((before?.slotId ?? null) !== (now.slotId ?? null)) { bump(before?.slotId, -1); bump(now.slotId, 1); } }
  }
  return d;
}

export function overlayTree(data: Any, st: State, c: Ctx): Any {
  const deltas = slotDeltas(st, c);
  if (![...deltas.values()].some((n) => n !== 0)) return data;
  const tree = clone(data);
  for (const w of tree.warehouses ?? []) {
    w.occupied = 0;
    for (const a of w.areas ?? []) {
      a.occupied = 0;
      for (const r of a.racks ?? []) {
        r.occupied = 0;
        for (const lv of r.levels ?? []) for (const s of lv.slots ?? []) { s.occupied = Math.max(0, s.occupied + (deltas.get(s.id) ?? 0)); r.occupied += s.occupied; }
        a.occupied += r.occupied;
      }
      w.occupied += a.occupied;
    }
  }
  return tree;
}

/** Espacios como los daría el servidor (activos, con lugar si se pide, ordenados por código). */
export function slotsFromTreeList(tree: Any, path: string): Any {
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  const term = q.get('q')?.toLowerCase();
  const items: Any[] = [];
  for (const w of tree?.warehouses ?? []) {
    if (!w.isActive) continue;
    for (const a of w.areas ?? []) {
      if (!a.isActive || (q.get('areaId') && a.id !== Number(q.get('areaId')))) continue;
      for (const r of a.racks ?? []) {
        if (!r.isActive || (q.get('rackId') && r.id !== Number(q.get('rackId')))) continue;
        for (const lv of r.levels ?? []) for (const s of lv.slots ?? []) {
          if (!s.isActive || (term && !String(s.code).toLowerCase().includes(term))) continue;
          if (q.get('free') && s.occupied >= s.capacity) continue;
          items.push({ id: s.id, code: s.code, capacity: s.capacity, levelNo: s.levelNo ?? lv.levelNo, slotNo: s.slotNo, rackId: r.id, areaId: a.id, warehouseId: w.id, occupied: s.occupied });
        }
      }
    }
  }
  items.sort((x, y) => String(x.code).localeCompare(String(y.code)));
  return { items: items.slice(0, 500) };
}

/** Un espacio para cada equipo, con el mismo criterio del servidor (reglas de los niveles, agrupar parecidos, ocupación). */
export async function localSuggest(body: Any, st: State, c: Ctx): Promise<{ items: Suggestion[] }> {
  const tree = (await cacheGet('/locations/tree'))?.data;
  if (!tree) throw new ApiError(0, 'offline_no_cache');
  const info = slotsFromTree(tree);
  const live = await liveUnits(st);
  const ids: number[] = (body?.unitIds ?? []).map(resolveId);
  const units = ids.map((id) => live.get(id)).filter(Boolean).map(placeable);
  const moving = new Set(ids);
  const slots: SlotState[] = [];
  for (const s of info.values()) {
    if (!s.isActive) continue;
    slots.push({ id: s.id, code: s.code, areaId: s.areaId ?? 0, order: s.order, capacity: s.capacity, occupied: 0, preferredTypes: new Set(s.preferredTypes), residents: [], rule: s.rule });
  }
  const bySlot = new Map(slots.map((s) => [s.id, s]));
  for (const u of live.values()) {
    if (!u.slotId || moving.has(u.id)) continue;
    const s = bySlot.get(u.slotId);
    if (s) { s.occupied++; s.residents.push(placeable(u)); }
  }
  const w = c.meta?.settings?.placement ?? { emptySlot: 5, preferredArea: 20, sameType: 30, sameModel: 100, sameGrade: 10, fillStarted: 10 };
  return { items: suggestPlacement(slots, units, w) };
}

