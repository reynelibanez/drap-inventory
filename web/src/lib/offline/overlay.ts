import { ApiError } from '../apiError';
import { cacheGet, cacheVersion, loadCachedMeta } from './cache';
import { matchesLot, matchesUnit, parseQuery, sortUnits } from './derive';
import { overlayAssetDetail, overlayAssetList, respondAsset, validateAsset } from './domains/assets';
import {
  orderDetail, overlayOrderList, pickListOf, respondOrderKind, validateOrder, localQuickCheck, prepareOrder, type Prepared,
} from './domains/orders';
import { overlayPartnerDetail, overlayPartnerList, partnerKindOf, respondPartner, validatePartner } from './domains/partners';
import { liveUnits, localSuggest, overlayTree, respondStock, slotsFromTreeList, validateStock } from './domains/stock';
import { isTemp, listOps, outboxVersion, pathIds, resolveId, type Op } from './outbox';
import { computeState, isLotOp, isUnitOp, LOT_FLOW, lotOfLotOp, testingCount, unitTarget } from './reduce';
import {
  cleanSerial, DELETED, forgetScan, mergeSpecs, orderIdsOf, scanUnits, unitIdsOf, type Any, type Ctx, type CtxExtra, type Env, type State,
} from './state';

/**
 * Lo que la app muestra mientras hay acciones sin sincronizar: se toma lo último que mandó el servidor y se le aplican, en orden,
 * las acciones pendientes (lote nuevo, conteos, equipos testeados, pedidos, ventas, ubicaciones, clientes, activos…). Así la pantalla
 * refleja el trabajo hecho aunque el servidor todavía no lo conozca. Al sincronizar, las pantallas se recargan con los datos reales.
 *
 * Las respuestas "de mentira" mantienen la misma forma que las del servidor, por eso las pantallas no saben si hay conexión o no.
 */

export { forgetScan };

const active = () => listOps().filter((o) => o.state === 'pending' || o.state === 'failed');

// ---------------------------------------------------------------- estado combinado (con memoria mientras nada cambie)

type Computed = { st: State; c: Ctx; env: Env };
let memo: { key: string; value: Promise<Computed> } | null = null;

/** El estado con todas las acciones pendientes aplicadas. Se reutiliza si ni la bandeja ni la copia local cambiaron. */
function stateFor(ops: Op[], extra: CtxExtra = {}): Promise<Computed> {
  const key = `${outboxVersion()}|${cacheVersion()}|${ops.length}|${JSON.stringify(extra)}`;
  if (memo?.key === key) return memo.value;
  const value = computeState(ops, extra);
  memo = { key, value };
  value.catch(() => { if (memo?.value === value) memo = null; });
  return value;
}

/** ¿Alguna acción cambia equipos (estado, precio, lugar, reserva…) además de las de lotes y testeo? */
const touchesStock = (o: Op) => isUnitOp(o) || o.kind.startsWith('loc.') || o.kind.startsWith('order.') || o.kind === 'quick.sale';

// ---------------------------------------------------------------- consultas (GET)

function rowFromLot(l: Any): Any {
  const s = l.summary;
  return {
    id: l.id, code: l.code, statusId: l.statusId, statusKey: l.statusKey, supplierId: l.supplierId, supplierName: l.supplierName,
    purchaseDate: l.purchaseDate, reference: l.reference, createdAt: l.createdAt,
    expected: s.expected, counted: s.counted, lines: l.lines.length, uncountedLines: s.uncountedLines, units: s.units,
    inTesting: testingCount(l),
    deletable: l.deletable, pendingSync: true,
  };
}

/** Aplica las acciones pendientes a la respuesta de una consulta. Si no hay nada pendiente devuelve la respuesta tal cual. */
export async function overlayGet(path: string, data: Any): Promise<Any> {
  const ops = active();
  if (!ops.length || data === null || data === undefined) return data;
  const p = path.split('?')[0];

  let m: RegExpMatchArray | null;
  if (p === '/lots' && Array.isArray(data.items)) return overlayLots(path, data, ops);
  if ((m = p.match(/^\/lots\/(-?\d+)$/))) return overlayLotDetail(Number(m[1]), data, ops);
  if (p === '/units' && Array.isArray(data.items)) return overlayUnits(path, data, ops);
  if ((m = p.match(/^\/units\/(-?\d+)$/))) return overlayUnitDetail(Number(m[1]), data, ops);
  if (p === '/orders' && Array.isArray(data.items)) return overlayOrders(path, data, ops);
  if ((m = p.match(/^\/orders\/(-?\d+)$/))) return overlayOrderDetail(Number(m[1]), data, ops);
  if ((m = p.match(/^\/orders\/(-?\d+)\/pick-list$/))) return overlayPickList(Number(m[1]), data, ops);
  if (p === '/assets' && Array.isArray(data.items)) return overlayAssets(path, data, ops);
  if ((m = p.match(/^\/assets\/(-?\d+)$/))) return overlayAssetDetail2(Number(m[1]), data, ops);
  const kind = partnerKindOf(p);
  if (kind && Array.isArray(data.items) && p === `/${kind}`) return overlayPartners(kind, path, data, ops);
  if (kind && (m = p.match(/^\/[a-z]+\/(-?\d+)$/))) return overlayPartnerDetail2(kind, Number(m[1]), data, ops);
  if (p === '/locations/tree') return overlayTree2(data, ops);
  if (p === '/locations/slots' && Array.isArray(data.items)) return overlaySlots(path, data, ops);
  return data;
}

async function overlayLotDetail(id: number, data: Any, ops: Op[]): Promise<Any> {
  const rid = resolveId(id);
  if (!ops.some((o) => isLotOp(o) || o.kind === 'unit.create' || isUnitOp(o))) return data;
  const { st } = await stateFor(ops);
  const l = st.lots.get(rid);
  if (l === DELETED) throw new ApiError(404, 'lot_not_found');
  return l ?? data;
}

async function overlayLots(path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => isLotOp(o) || isUnitOp(o))) return data;
  const { st } = await stateFor(ops);
  const q = parseQuery(path);
  const rows: Any[] = [];
  for (const r of data.items as Any[]) {
    const l = st.lots.get(r.id);
    if (l === DELETED) continue;
    rows.push(l && st.touchedLots.has(r.id) ? { ...r, ...rowFromLot(l) } : r);
  }
  const fresh: Any[] = [];
  for (const id of st.createdLots) { const l = st.lots.get(id); if (l && l !== DELETED) fresh.push(rowFromLot(l)); }
  const items = [...fresh.reverse(), ...rows].filter((r) => matchesLot(q, r));
  return { ...data, items, total: Math.max(0, data.total + items.length - data.items.length) };
}

async function overlayUnits(path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some(touchesStock)) return data;
  const { st } = await stateFor(ops);
  if (!st.touchedUnits.size) return data;
  const q = parseQuery(path);
  const existing = new Set<number>();
  const rows: Any[] = [];
  for (const u of data.items as Any[]) {
    existing.add(u.id);
    const n = st.units.get(u.id);
    if (n === DELETED) continue;
    if (n && st.touchedUnits.has(u.id)) { if (matchesUnit(q, n)) rows.push({ ...u, ...n }); continue; }
    rows.push(u);
  }
  // Equipos que por lo pendiente ahora sí cumplen el filtro (p. ej. recién testeados y "disponibles"): solo si el listado es completo.
  const complete = data.total <= data.items.length;
  const fresh: Any[] = [];
  for (const id of st.touchedUnits) {
    const u = st.units.get(id);
    if (!u || u === DELETED || existing.has(id) || !matchesUnit(q, u)) continue;
    if (isTemp(id)) fresh.push(u);
    else if (complete) rows.push(u);
  }
  const sort = q.get('sort') ?? 'newest';
  const merged = sortUnits(rows, sort);
  const items = sort === 'newest' ? [...fresh.reverse(), ...merged] : [...merged, ...fresh];
  return { ...data, items, total: Math.max(0, data.total + items.length - data.items.length) };
}

async function overlayUnitDetail(id: number, data: Any, ops: Op[]): Promise<Any> {
  const rid = resolveId(id);
  if (!ops.some(touchesStock)) return data;
  const { st } = await stateFor(ops);
  const u = st.units.get(rid);
  if (u === DELETED) throw new ApiError(404, 'unit_not_found');
  if (!u || !st.touchedUnits.has(rid)) return data;
  return { ...(data ?? {}), ...u, history: data?.history ?? [] };
}

// ---- pedidos

async function overlayOrders(path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => o.kind.startsWith('order.') || o.kind === 'quick.sale')) return data;
  const { st, c } = await stateFor(ops);
  return overlayOrderList(path, data, st, c);
}

async function overlayOrderDetail(id: number, data: Any, ops: Op[]): Promise<Any> {
  const rid = resolveId(id);
  if (!ops.some(touchesStock)) return data;
  const { st, env } = await stateFor(ops, { orders: [rid] });
  const m = env.order(rid);
  if (!m) return data;
  if (!st.touchedOrders.has(rid) && !st.touchedUnits.size) return data;
  return { ...data, ...(await orderDetail(m, env)) };
}

async function overlayPickList(id: number, data: Any, ops: Op[]): Promise<Any> {
  const rid = resolveId(id);
  if (!ops.some(touchesStock)) return data;
  const { st, env } = await stateFor(ops, { orders: [rid] });
  const m = env.order(rid);
  if (!m || (!st.touchedOrders.has(rid) && !st.touchedUnits.size)) return data;
  const detail = await orderDetail(m, env);
  return pickListOf(detail, [...(await liveUnits(st)).values()]);
}

// ---- clientes, vendedores, proveedores, activos

async function overlayPartners(kind: 'suppliers' | 'customers' | 'sellers', path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => o.kind.startsWith('partner.'))) return data;
  const { st } = await stateFor(ops);
  return overlayPartnerList(kind, path, data, st);
}
async function overlayPartnerDetail2(kind: 'suppliers' | 'customers' | 'sellers', id: number, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => o.kind.startsWith('partner.'))) return data;
  const { st } = await stateFor(ops);
  return overlayPartnerDetail(kind, resolveId(id), data, st);
}

async function overlayAssets(path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => o.kind.startsWith('asset.'))) return data;
  const { st } = await stateFor(ops);
  return overlayAssetList(path, data, st);
}
async function overlayAssetDetail2(id: number, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some((o) => o.kind.startsWith('asset.'))) return data;
  const { st } = await stateFor(ops);
  return overlayAssetDetail(resolveId(id), data, st);
}

// ---- ubicaciones

async function overlayTree2(data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some(touchesStock)) return data;
  const { st, c } = await stateFor(ops, { slots: true });
  return overlayTree(data, st, c);
}

async function overlaySlots(path: string, data: Any, ops: Op[]): Promise<Any> {
  if (!ops.some(touchesStock)) return data;
  const { st, c } = await stateFor(ops, { slots: true });
  if (!st.touchedUnits.size) return data;
  const tree = (await cacheGet('/locations/tree'))?.data;
  return tree ? slotsFromTreeList(overlayTree(tree, st, c), path) : data;
}

// ---------------------------------------------------------------- lecturas de lo que solo existe en la bandeja

/** Respuesta a una consulta de algo que solo existe en la bandeja (lote, equipo, pedido, cliente o activo aún no enviado al servidor). */
export async function synthGet(path: string): Promise<Any | undefined> {
  const p = path.split('?')[0];
  const ids = pathIds(p);
  if (!ids.length || !isTemp(resolveId(ids[0]))) return undefined;
  const id = resolveId(ids[0]);
  const ops = listOps();
  let m: RegExpMatchArray | null;

  if ((m = p.match(/^\/lots\/-?\d+$/))) {
    const { st } = await stateFor(ops);
    const l = st.lots.get(id);
    if (!l || l === DELETED) throw new ApiError(404, 'lot_not_found');
    return l;
  }
  if (/^\/units\/-?\d+$/.test(p)) {
    const { st } = await stateFor(ops);
    const u = st.units.get(id);
    if (!u || u === DELETED) throw new ApiError(404, 'unit_not_found');
    return { ...u, history: [] };
  }
  if (/^\/orders\/-?\d+(\/pick-list)?$/.test(p)) {
    const { st, env } = await stateFor(ops);
    const o = st.orders.get(id);
    if (!o || o === DELETED) throw new ApiError(404, 'order_not_found');
    const detail = await orderDetail(o, env);
    return p.endsWith('/pick-list') ? pickListOf(detail, [...(await liveUnits(st)).values()]) : detail;
  }
  if (/^\/assets\/-?\d+$/.test(p)) {
    const { st } = await stateFor(ops);
    const a = st.assets.get(id);
    if (!a || a === DELETED) throw new ApiError(404, 'asset_not_found');
    return { ...a, history: [] };
  }
  const kind = partnerKindOf(p);
  if (kind && /^\/[a-z]+\/-?\d+$/.test(p)) {
    const { st } = await stateFor(ops);
    const r = (st.partnersCreated[kind] ?? []).find((x) => x.id === id);
    if (!r) throw new ApiError(404, 'not_found');
    return r;
  }
  return undefined;
}

/** Consultas que se responden con lo local aunque la petición sea POST (revisar códigos de venta rápida, sugerir ubicación). */
export async function localPost(path: string, body: Any): Promise<Any | undefined> {
  const p = path.split('?')[0];
  if (p === '/quick-sales/check') {
    const { st } = await stateFor(listOps());
    return localQuickCheck((body?.codes ?? []) as string[], st);
  }
  if (p === '/locations/suggest') {
    const { st, c } = await stateFor(listOps(), { slots: true, units: (body?.unitIds ?? []) as number[] });
    return localSuggest(body, st, c);
  }
  return undefined;
}

// ---------------------------------------------------------------- respuestas a acciones guardadas

/** La respuesta que daría el servidor a esta acción (con datos provisionales). Se calcula con la acción ya en la bandeja. */
export async function respondTo(op: Op, prepared?: Prepared): Promise<Any> {
  const ops = listOps();
  const { st, env } = await stateFor(ops, { orders: orderIdsOf(op) });
  switch (op.kind) {
    case 'lot.create': return { id: op.temp!.lot, code: op.temp!.code, lines: (op.temp!.lines ?? []).map((id, i) => ({ id, lineNo: i + 1 })), pendingSync: true };
    case 'line.add': case 'line.unexpected': return { id: op.temp!.line, pendingSync: true };
    case 'catalog.item': return { id: op.temp!.item, existed: false, pendingSync: true };
    case 'lot.update': case 'line.update': case 'line.delete': case 'lot.delete': case 'unit.delete': return { ok: true, pendingSync: true };
    case 'lot.counts': case 'lot.transition': {
      const l = st.lots.get(lotOfLotOp(op));
      return l && l !== DELETED ? l : { ok: true, pendingSync: true };
    }
    case 'unit.create': case 'unit.finish': case 'unit.update': {
      const u = st.units.get(resolveId(unitTarget(op)));
      return u && u !== DELETED ? { ...u, history: [] } : { ok: true, pendingSync: true };
    }
    case 'unit.status': case 'unit.costs': case 'unit.prices': case 'loc.assign': case 'loc.unassign': return respondStock(op, st);
    case 'partner.create': case 'partner.update': return respondPartner(op, st);
    case 'asset.create': case 'asset.update': case 'asset.delete': return respondAsset(op, st);
    case 'order.create': case 'quick.sale': return respondOrderKind(op, st) ?? { ok: true, pendingSync: true };
    default: {
      if (!op.kind.startsWith('order.')) return { ok: true, pendingSync: true };
      const m = env.order(pathIds(op.path)[0]);
      if (!m) return { ok: true, pendingSync: true };
      const detail = await orderDetail(m, env);
      return prepared?.respond ? prepared.respond({ op, st, detail }) : detail;
    }
  }
}

/** Respuesta de una acción que no guarda nada (p. ej. escanear códigos que no se pueden agregar): usa el pedido tal como está. */
export async function respondDone(prepared: Prepared, path: string): Promise<Any> {
  const id = resolveId(pathIds(path)[0]);
  const { env } = await stateFor(listOps(), { orders: [id] });
  const m = env.order(id);
  if (!m) return { ok: true };
  return prepared.done!(await orderDetail(m, env));
}

// ---------------------------------------------------------------- validación previa (mismos avisos que daría el servidor)

/** Datos obligatorios de un tipo de equipo (lo que el usuario configuró), con el mismo error que da el servidor. */
async function checkRequired(typeId: number, specs: Record<string, unknown>, stage: 'lot' | 'test') {
  const meta = await loadCachedMeta();
  const type = meta?.equipmentTypes?.find((t: Any) => t.id === typeId);
  if (!type) return;
  for (const cfg of type.attributes as Any[]) {
    if (!cfg.isActive) continue;
    const attr = meta.attributes.find((a: Any) => a.id === cfg.attributeId);
    if (!attr?.isActive) continue;
    if (stage === 'lot' && !cfg.inLotLine) continue;
    if (!(stage === 'lot' ? cfg.requiredOnLot : cfg.requiredOnTest)) continue;
    const v = specs[attr.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) throw new ApiError(400, 'required_attribute', { attribute: attr.key });
  }
}

/** Convierte lo que pidió la persona en la acción que se guarda (los pedidos eligen aquí los equipos). `null` = se guarda tal cual. */
export async function prepare(kind: Op['kind'], path: string, body: Any): Promise<Prepared | null> {
  if (!kind.startsWith('order.') && kind !== 'quick.sale') return null;
  const id = kind === 'order.create' || kind === 'quick.sale' ? undefined : resolveId(pathIds(path)[0]);
  const { env } = await stateFor(listOps(), { orders: id === undefined ? [] : [id] });
  return prepareOrder(kind, path, body, env);
}

/** Revisa lo que ya se puede saber sin servidor. Lanza el mismo error que el servidor para que la pantalla responda igual. */
export async function validateOp(kind: Op['kind'], path: string, body: Any): Promise<void> {
  if (kind === 'catalog.item') return;
  if (kind === 'unit.finish' || kind === 'unit.update' || kind === 'unit.delete') return validateUnitEdit(kind, path, body);

  const pseudo = { kind, path, body } as Op;
  if (kind === 'unit.status' || kind === 'unit.costs' || kind === 'unit.prices' || kind === 'loc.assign' || kind === 'loc.unassign') {
    const { env } = await stateFor(listOps(), { units: unitIdsOf(pseudo), slots: kind === 'loc.assign' });
    return validateStock(kind, path, body, env);
  }
  if (kind.startsWith('partner.')) {
    const pk = partnerKindOf(path);
    if (pk) validatePartner({ body }, pk);
    return;
  }
  if (kind.startsWith('asset.')) {
    const { st } = await stateFor(listOps());
    return validateAsset({ kind, path, body }, st);
  }
  if (kind.startsWith('order.') || kind === 'quick.sale') {
    const { env } = await stateFor(listOps(), { orders: orderIdsOf(pseudo), units: unitIdsOf(pseudo), partners: true });
    return validateOrder(kind, path, body, env);
  }

  if (kind === 'lot.create') { for (const l of body?.lines ?? []) await checkRequired(l.equipmentTypeId, l.specs ?? {}, 'lot'); return; }
  if (kind === 'line.add' || kind === 'line.update') await checkRequired(body?.equipmentTypeId, body?.specs ?? {}, 'lot');
  const lotId = resolveId(pathIds(path)[0]);
  const { st } = await stateFor(listOps(), { lots: [lotId] });
  const raw = st.lots.get(lotId);
  if (raw === DELETED) throw new ApiError(404, 'lot_not_found');
  const lot: Any | null = raw ?? null;
  if (!lot) return;   // no hay copia del lote: lo decidirá el servidor al sincronizar

  const closed = () => { if (lot.statusKey === 'closed') throw new ApiError(409, 'lot_closed'); };
  switch (kind) {
    case 'lot.update': case 'line.add': case 'line.update': case 'line.delete': case 'line.unexpected': closed(); break;
    case 'lot.counts': {
      closed();
      for (const r of body?.counts ?? []) {
        const ln = (lot.lines as Any[]).find((l) => l.id === resolveId(r.lineId));
        if (ln && r.countedQty !== null && r.countedQty < ln.tested) throw new ApiError(409, 'count_below_tested', { tested: ln.tested });
      }
      break;
    }
    case 'unit.create': {
      closed();
      if (lot.statusKey === 'open' || lot.statusKey === 'counting') throw new ApiError(409, 'lot_not_counted');
      const serial = cleanSerial(body?.serialNumber);
      if (serial) await checkSerial(serial, null, st);
      break;
    }
    case 'lot.transition': {
      const target = LOT_FLOW[lot.statusKey]?.[body?.action];
      if (!target) throw new ApiError(409, 'invalid_transition', { from: lot.statusKey, action: body?.action });
      if (body?.action === 'finish_count' && !body?.force) {
        const pending = (lot.lines as Any[]).filter((l) => l.countedQty === null).length;
        if (pending > 0) throw new ApiError(409, 'lines_not_counted', { pending });
      }
      if (body?.action === 'close' && testingCount(lot) > 0) throw new ApiError(409, 'units_in_testing', { count: testingCount(lot) });
      break;
    }
    case 'lot.delete': {
      if (lot.summary.units > 0) throw new ApiError(409, 'lot_has_units');
      if (!lot.deletable) throw new ApiError(409, 'lot_has_counts');
      break;
    }
  }
  if (kind === 'line.delete') {
    const ln = (lot.lines as Any[]).find((l) => l.id === resolveId(pathIds(path)[1]));
    if (ln && ln.tested > 0) throw new ApiError(409, 'line_has_units');
  }
}

function checkUnitEditable(u: Any, kind: Op['kind']) {
  if (u.statusKey === 'sold') throw new ApiError(409, 'unit_sold', { code: u.code });
  if (kind === 'unit.finish' && !['testing', 'available', 'not_sellable'].includes(u.statusKey)) throw new ApiError(409, 'unit_not_editable', { status: u.statusKey });
}

async function checkSerial(serial: string, exceptId: number | null, st: State) {
  const low = serial.toLowerCase();
  for (const [id, u] of st.units) {
    if (u === DELETED || id === exceptId) continue;
    if ((u.serialNumber ?? '').toLowerCase() === low) throw new ApiError(409, 'serial_duplicate', { code: u.code, unitId: u.id });
  }
  for (const u of (await scanUnits()).values()) {
    if (u.id === exceptId || st.units.has(u.id)) continue;
    if ((u.serialNumber ?? '').toLowerCase() === low) throw new ApiError(409, 'serial_duplicate', { code: u.code, unitId: u.id });
  }
}

/** Revisa serie repetida y estado del equipo antes de guardar cambios de un equipo. */
export async function validateUnitEdit(kind: 'unit.finish' | 'unit.update' | 'unit.delete', path: string, body: Any): Promise<void> {
  const id = resolveId(pathIds(path)[0]);
  const { st, c } = await stateFor(listOps(), { units: [id] });
  const u = st.units.get(id) ?? c.baseUnits.get(id);
  if (u === DELETED) throw new ApiError(404, 'unit_not_found');
  if (u) checkUnitEditable(u, kind);
  if (kind === 'unit.delete') return;
  if (kind === 'unit.finish' && u) {
    const meta = await loadCachedMeta();
    if (meta?.equipmentTypes?.find((t: Any) => t.id === u.equipmentTypeId)?.tracksSerial && !('serialNumber' in (body ?? {}) ? cleanSerial(body.serialNumber) : u.serialNumber)) throw new ApiError(400, 'serial_required');
    await checkRequired(u.equipmentTypeId, mergeSpecs(u.specs, body?.specs), 'test');
  }
  const serial = cleanSerial(body?.serialNumber);
  if (serial && body && 'serialNumber' in body) await checkSerial(serial, id, st);
}
