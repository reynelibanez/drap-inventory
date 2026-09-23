import { ApiError } from '../../apiError';
import {
  applyAdjustments, matchUnit, money, parseAdjustments, unitFitsLine, type Adjustment, type MatchableUnit, type MatchStatus, type OrderLine,
} from '../logic';
import { newTempId, pathIds, resolveId, tempNumber, TEMP_BASE, type Op, type Temp } from '../outbox';
import {
  clean, cleanSpecs, DELETED, iso, overlaySession, sysId, type Any, type Ctx, type Env, type OrderItem, type OrderLineModel, type OrderModel, type State,
} from '../state';
import { partnerRow } from './partners';
import { liveUnits } from './stock';

/** Pedidos y venta rápida: reserva de equipos, líneas, precios, descuentos, cierre y cancelación. */

const EMPTY_SHIPPING = { weightUnit: 'lb', dimUnit: 'in', packages: [] as Any[] };

function normalizeShipping(raw: Any): Any {
  const ok = raw && (raw.weightUnit === 'lb' || raw.weightUnit === 'kg') && (raw.dimUnit === 'in' || raw.dimUnit === 'cm') && Array.isArray(raw.packages);
  return ok ? raw : { ...EMPTY_SHIPPING, packages: [] };
}

// ---------------------------------------------------------------- modelo

const snapOf = (u: Any): Any => ({
  code: u.code, serialNumber: u.serialNumber ?? null, specs: u.specs ?? {}, equipmentTypeId: u.equipmentTypeId, cosmeticGradeId: u.cosmeticGradeId ?? null,
  functionalGradeId: u.functionalGradeId ?? null, lotId: u.lotId, lotCode: u.lotCode, slotCode: u.slotCode ?? null, listPrice: u.listPrice ?? null, cost: u.cost ?? null,
});

export function modelFromDetail(d: Any): OrderModel {
  return {
    id: d.id, code: d.code, statusKey: d.statusKey, customerId: d.customerId ?? null, sellerId: d.sellerId ?? null, notes: d.notes ?? null,
    customer: d.customerId || d.customerName ? { name: d.customerName, address: d.customerAddress ?? null, phone: d.customerPhone ?? null, contact: d.customerContact ?? null, country: d.customerCountry ?? null } : null,
    sellerName: d.sellerName ?? null,
    reservedUntil: d.reservedUntil ?? null, currency: d.currency, isQuick: !!d.isQuick, createdAt: d.createdAt, completedAt: d.completedAt ?? null, cancelledAt: d.cancelledAt ?? null,
    shipping: normalizeShipping(d.shipping),
    adjustments: (d.adjustments ?? []).map((a: Any) => ({ label: a.label, kind: a.kind, value: a.value })),
    lines: (d.lines ?? []).map((l: Any) => ({
      id: l.id, lineNo: l.lineNo, equipmentTypeId: l.equipmentTypeId, specs: l.specs ?? {}, cosmeticGradeIds: l.cosmeticGradeIds ?? [], functionalGradeIds: l.functionalGradeIds ?? [],
      quantity: l.quantity, unitPrice: l.unitPrice ?? null, notes: l.notes ?? null,
    })),
    items: (d.items ?? []).map((i: Any) => ({
      id: i.id, unitId: i.unitId, unitPrice: i.unitPrice ?? null, lineId: i.lineId ?? null, matchStatus: i.matchStatus ?? null,
      snap: snapOf({ ...i, cost: i.unitCost, listPrice: i.listPrice }),
    })),
  };
}

const linesOf = (m: OrderModel): OrderLine[] => m.lines.map((l) => ({ ...l, picked: m.items.filter((i) => i.lineId === l.id).length }));
const matchable = (u: Any): MatchableUnit => ({ id: u.id, equipmentTypeId: u.equipmentTypeId, specs: u.specs ?? {}, cosmeticGradeId: u.cosmeticGradeId ?? null, functionalGradeId: u.functionalGradeId ?? null });
const uniq = (a: number[] | undefined) => [...new Set(a ?? [])];

function setCustomer(m: OrderModel, env: Env, id: number | null) {
  m.customerId = id;
  const r = id ? partnerRow(env.st, env.c, 'customers', id) : null;
  m.customer = r ? { name: r.name, address: r.address ?? null, phone: r.phone ?? null, contact: r.contactName ?? null, country: r.country ?? null } : id ? m.customer : null;
}
function setSeller(m: OrderModel, env: Env, id: number | null) {
  m.sellerId = id;
  const r = id ? partnerRow(env.st, env.c, 'sellers', id) : null;
  m.sellerName = r ? r.name : id ? m.sellerName : null;
}

function setUnitStatus(env: Env, u: Any, key: string) {
  u.statusKey = key; u.statusId = sysId(env.c, 'unit_status', key); u.pendingSync = true;
  env.st.touchedUnits.add(resolveId(u.id));
}

// ---------------------------------------------------------------- reservar y liberar

export interface Reserved { unitId: number; code: string; status: MatchStatus; lineId: number | null }

/** Reserva equipos disponibles dentro del pedido (cada uno se asocia a la línea que le corresponde). */
function reserve(env: Env, m: OrderModel, o: Op, unitIds: number[], opts: { price?: number | null; lineId?: number | null }): Reserved[] {
  const ids = uniq(unitIds.map(resolveId)).sort((a, b) => a - b);
  const lines = linesOf(m);
  const taken = new Map<number, number>();
  const out: Reserved[] = [];
  for (const id of ids) {
    const u = env.unit(id);
    if (!u) continue;
    let line: OrderLine | null; let status: MatchStatus;
    if (opts.lineId) { line = lines.find((l) => l.id === resolveId(opts.lineId!)) ?? null; status = 'ok'; }
    else ({ line, status } = matchUnit(matchable(u), lines, taken));
    if (line) taken.set(line.id, (taken.get(line.id) ?? 0) + 1);
    const price = opts.price ?? line?.unitPrice ?? u.listPrice ?? null;
    const idx = (o.temp?.itemUnits ?? []).findIndex((x) => resolveId(x) === id);
    m.items.push({
      id: idx >= 0 && o.temp?.saleItems ? o.temp.saleItems[idx] : -(TEMP_BASE * 2 + id), unitId: id, unitPrice: price, lineId: line?.id ?? null,
      matchStatus: opts.lineId ? 'ok' : status, snap: snapOf(u),
    });
    setUnitStatus(env, u, 'reserved');
    u.orderId = m.id; u.orderCode = m.code;
    out.push({ unitId: id, code: u.code, status, lineId: line?.id ?? null });
  }
  return out;
}

/** Quita renglones del pedido; los equipos reservados vuelven a estar disponibles. */
function release(env: Env, m: OrderModel, itemIds: number[]) {
  const gone = new Set(itemIds);
  for (const i of m.items.filter((x) => gone.has(x.id))) {
    const u = env.unit(i.unitId);
    if (!u) continue;
    if (u.statusKey === 'reserved') setUnitStatus(env, u, 'available');
    u.orderId = null; u.orderCode = null;
  }
  m.items = m.items.filter((i) => !gone.has(i.id));
}

// ---------------------------------------------------------------- reglas de cada acción

const lineFrom = (b: Any, id: number, lineNo: number, keepPrice: number | null = null): OrderLineModel => ({
  id, lineNo, equipmentTypeId: b.equipmentTypeId, specs: cleanSpecs(b.specs), cosmeticGradeIds: uniq(b.cosmeticGradeIds), functionalGradeIds: uniq(b.functionalGradeIds),
  quantity: b.quantity, unitPrice: overlaySession().can('sales.price') ? b.unitPrice ?? null : keepPrice, notes: clean(b.notes, 500),
});

function newOrder(o: Op, env: Env, opts: { quick: boolean }): OrderModel {
  const { c } = env;
  const b = o.body ?? {};
  const days = c.meta?.settings?.reservationDays;
  const reservedUntil = opts.quick ? null : b.reservedUntil ?? (days ? new Date(o.created + days * 86400_000).toISOString() : null);
  const m: OrderModel = {
    id: o.temp!.order!, code: o.temp!.code!, statusKey: opts.quick ? 'completed' : 'open', customerId: null, sellerId: null, customer: null, sellerName: null,
    notes: clean(b.notes, 1000), reservedUntil, currency: c.meta?.company?.currency ?? 'USD', isQuick: opts.quick, createdAt: iso(o.created),
    completedAt: opts.quick ? iso(o.created) : null, cancelledAt: null, shipping: { ...EMPTY_SHIPPING, packages: [] }, adjustments: [], lines: [], items: [],
  };
  setCustomer(m, env, b.customerId ?? null);
  setSeller(m, env, b.sellerId ?? null);
  return m;
}

export function applyOrderOp(o: Op, env: Env) {
  const { st } = env;
  const b = o.body ?? {};
  const can = overlaySession().can;

  if (o.kind === 'order.create') {
    const m = newOrder(o, env, { quick: false });
    st.orders.set(m.id, m); st.createdOrders.push(m.id); st.touchedOrders.add(m.id);
    (b.lines ?? []).forEach((l: Any, i: number) => m.lines.push(lineFrom(l, o.temp!.orderLines![i], i + 1)));
    const groups: Any[] = o.temp?.plan?.groups ?? [];
    groups.forEach((g, j) => {
      const at = (b.lines ?? []).length + j;
      m.lines.push(lineFrom({ equipmentTypeId: g.typeId, specs: g.specs, cosmeticGradeIds: g.cos ? [g.cos] : [], functionalGradeIds: g.fun ? [g.fun] : [], quantity: g.n }, o.temp!.orderLines![at], at + 1));
    });
    if (b.fromUnitIds?.length) st.results.set(o.seq, { reserved: reserve(env, m, o, b.fromUnitIds, {}) });
    return;
  }

  if (o.kind === 'quick.sale') {
    const m = newOrder(o, env, { quick: true });
    st.orders.set(m.id, m); st.createdOrders.push(m.id); st.touchedOrders.add(m.id);
    const price = can('sales.price') ? b.unitPrice ?? null : null;
    for (const id of uniq((b.unitIds ?? []).map(resolveId)).sort((x, y) => x - y)) {
      const u = env.unit(id);
      if (!u) continue;
      m.items.push({ id: -(TEMP_BASE * 2 + id), unitId: id, unitPrice: price ?? u.listPrice ?? null, lineId: null, matchStatus: null, snap: snapOf(u) });
      setUnitStatus(env, u, 'sold');
      u.orderId = m.id; u.orderCode = m.code;
    }
    st.results.set(o.seq, { count: m.items.length });
    return;
  }

  const m = env.order(pathIds(o.path)[0]);
  if (!m) return;
  st.touchedOrders.add(m.id);
  switch (o.kind) {
    case 'order.update':
      if (b.customerId) setCustomer(m, env, b.customerId);
      if (b.sellerId !== undefined) setSeller(m, env, b.sellerId ?? null);
      if (b.notes !== undefined) m.notes = clean(b.notes, 1000);
      if (b.reservedUntil !== undefined) m.reservedUntil = b.reservedUntil ?? null;
      break;
    case 'order.shipping': m.shipping = normalizeShipping(b); break;
    case 'order.items': {
      const price = can('sales.price') ? b.unitPrice ?? null : null;
      st.results.set(o.seq, { reserved: reserve(env, m, o, b.unitIds ?? [], { price, lineId: b.lineId ?? null }) });
      break;
    }
    case 'order.items_remove': release(env, m, b.itemIds ?? []); break;
    case 'order.prices': {
      if (Array.isArray(b.prices)) {
        const by = new Map<number, number | null>(b.prices.map((p: Any) => [resolveId(p.itemId), p.unitPrice]));
        for (const i of m.items) if (by.has(i.id)) i.unitPrice = by.get(i.id)!;
      } else {
        const only = b.itemIds ? new Set<number>(b.itemIds.map(resolveId)) : null;
        for (const i of m.items) if (!only || only.has(i.id)) i.unitPrice = b.unitPrice ?? null;
      }
      break;
    }
    case 'order.adjustments': m.adjustments = parseAdjustments(b.adjustments); break;
    case 'order.line_add': m.lines.push(lineFrom(b, o.temp!.orderLine!, Math.max(0, ...m.lines.map((l) => l.lineNo)) + 1)); break;
    case 'order.line_update': {
      const id = resolveId(pathIds(o.path)[1]);
      const i = m.lines.findIndex((l) => l.id === id);
      if (i >= 0) m.lines[i] = lineFrom(b, id, m.lines[i].lineNo, m.lines[i].unitPrice);
      break;
    }
    case 'order.line_delete': {
      const id = resolveId(pathIds(o.path)[1]);
      m.lines = m.lines.filter((l) => l.id !== id);
      for (const i of m.items) if (i.lineId === id) { i.lineId = null; i.matchStatus = 'no_match'; }
      break;
    }
    case 'order.complete':
      for (const i of m.items) { const u = env.unit(i.unitId); if (u && u.statusKey === 'reserved') setUnitStatus(env, u, 'sold'); }
      m.statusKey = 'completed'; m.completedAt = iso(o.created); m.reservedUntil = null;
      break;
    case 'order.cancel':
      release(env, m, m.items.map((i) => i.id));
      m.statusKey = 'cancelled'; m.cancelledAt = iso(o.created); m.reservedUntil = null;
      break;
  }
}

// ---------------------------------------------------------------- vistas (lo que ven las pantallas)

const itemSubtotal = (m: OrderModel, canPrice: boolean) => (canPrice ? money(m.items.reduce((a, i) => a + (i.unitPrice ?? 0), 0)) : null);

/** El pedido tal como lo devuelve el servidor (detalle). */
export async function orderDetail(m: OrderModel, env: Env): Promise<Any> {
  const { c, st } = env;
  const can = overlaySession().can;
  const canPrice = can('sales.price'), canCost = can('costs.view');
  const live = await liveUnits(st);
  const visible = m.items.filter((i) => st.units.get(i.unitId) !== DELETED);
  const items = visible.map((i) => {
    const u = live.get(i.unitId) ?? i.snap;
    return {
      id: i.id, unitId: i.unitId, unitPrice: canPrice ? i.unitPrice : null, listPrice: canPrice ? u.listPrice ?? null : null, unitCost: canCost ? u.cost ?? null : null,
      code: u.code, serialNumber: u.serialNumber ?? null, specs: u.specs ?? {}, equipmentTypeId: u.equipmentTypeId, cosmeticGradeId: u.cosmeticGradeId ?? null,
      functionalGradeId: u.functionalGradeId ?? null, lotId: u.lotId, lotCode: u.lotCode, slotCode: u.slotCode ?? null, lineId: i.lineId, matchStatus: i.matchStatus,
    };
  });
  const subtotal = canPrice ? money(items.reduce((a, i) => a + (i.unitPrice ?? 0), 0)) : null;
  const adj = subtotal === null ? { adjustments: [] as Any[], total: null as number | null } : applyAdjustments(subtotal, m.adjustments as Adjustment[]);
  let margin: Any = null;
  if (canPrice && canCost && subtotal !== null) {
    const cost = money(items.reduce((a, i) => a + (i.unitCost ?? 0), 0));
    const discounts = adj.adjustments.reduce((a: number, x: Any) => a + Math.min(0, x.amount), 0);
    const revenue = money(subtotal + discounts);
    margin = { cost, revenue, profit: money(revenue - cost), pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10000) / 100 : null, missing: items.filter((i) => i.unitCost === null).length };
  }
  const open = m.statusKey === 'open';
  const lines = linesOf({ ...m, items: m.items.filter((i) => visible.includes(i)) });
  const stock = open ? [...live.values()].filter((u) => u.statusKey === 'available') : [];
  return {
    id: m.id, code: m.code, statusId: sysId(c, 'order_status', m.statusKey), statusKey: m.statusKey, customerId: m.customerId, customerName: m.customer?.name ?? null,
    customerAddress: m.customer?.address ?? null, customerPhone: m.customer?.phone ?? null, customerContact: m.customer?.contact ?? null, customerCountry: m.customer?.country ?? null,
    shipping: m.shipping, sellerId: m.sellerId, sellerName: m.sellerName, isQuick: m.isQuick, currency: m.currency, reservedUntil: m.reservedUntil, notes: m.notes,
    completedAt: m.completedAt, cancelledAt: m.cancelledAt, createdAt: m.createdAt, items, itemCount: items.length,
    subtotal, adjustments: adj.adjustments, total: adj.total, margin, canSeePrices: canPrice, canSeeCosts: canCost,
    lines: lines.map((l) => ({ ...l, unitPrice: canPrice ? l.unitPrice : null, available: open ? stock.filter((u) => unitFitsLine(matchable(u), l)).length : 0 })),
    requested: lines.reduce((a, l) => a + l.quantity, 0),
    offOrder: items.filter((i) => i.matchStatus === 'no_match' || i.matchStatus === 'line_full').length,
    pendingSync: true,
  };
}

/** Una fila del listado de pedidos. */
export function orderRow(m: OrderModel, c: Ctx): Any {
  const canPrice = overlaySession().can('sales.price');
  const subtotal = itemSubtotal(m, canPrice);
  return {
    id: m.id, code: m.code, statusId: sysId(c, 'order_status', m.statusKey), statusKey: m.statusKey, customerName: m.customer?.name ?? null, sellerName: m.sellerName,
    currency: m.currency, reservedUntil: m.reservedUntil, createdAt: m.createdAt, completedAt: m.completedAt, isQuick: m.isQuick, lineCount: m.lines.length, itemCount: m.items.length,
    subtotal, total: subtotal === null ? null : applyAdjustments(subtotal, m.adjustments as Adjustment[]).total, pendingSync: true,
  };
}

const ordersFilter = (q: URLSearchParams, r: Any, m: OrderModel | null): boolean => {
  if (q.get('statusKey') && r.statusKey !== q.get('statusKey')) return false;
  if (q.get('customerId') && m && m.customerId !== Number(q.get('customerId'))) return false;
  if (q.get('sellerId') && m && m.sellerId !== Number(q.get('sellerId'))) return false;
  if (q.get('q')) { const t = q.get('q')!.toLowerCase(); if (!`${r.code} ${r.customerName ?? ''}`.toLowerCase().includes(t)) return false; }
  return true;
};

export function overlayOrderList(path: string, data: Any, st: State, c: Ctx): Any {
  if (!st.touchedOrders.size) return data;
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  const rows: Any[] = [];
  for (const r of data.items as Any[]) {
    const m = st.orders.get(r.id);
    if (m && m !== DELETED && st.touchedOrders.has(r.id)) { const row = { ...r, ...orderRow(m, c) }; if (ordersFilter(q, row, m)) rows.push(row); continue; }
    rows.push(r);
  }
  const fresh: Any[] = [];
  for (const id of st.createdOrders) { const m = st.orders.get(id); if (m && m !== DELETED) { const row = orderRow(m, c); if (ordersFilter(q, row, m)) fresh.push(row); } }
  const items = [...fresh.reverse(), ...rows];
  return { ...data, items, total: Math.max(0, data.total + items.length - data.items.length) };
}

// ---------------------------------------------------------------- listado para preparar el pedido (dónde está cada equipo)

export function pickListOf(order: Any, stock: Any[]) {
  const bySlot = new Map<string, { slotCode: string | null; units: Any[] }>();
  const lineNo = new Map<number, number>(order.lines.map((l: Any) => [l.id as number, l.lineNo as number]));
  for (const i of order.items as Any[]) {
    const k = i.slotCode ?? '';
    if (!bySlot.has(k)) bySlot.set(k, { slotCode: i.slotCode, units: [] });
    bySlot.get(k)!.units.push({ code: i.code, serialNumber: i.serialNumber, equipmentTypeId: i.equipmentTypeId, specs: i.specs, lineNo: i.lineId ? lineNo.get(i.lineId) ?? null : null, matchStatus: i.matchStatus });
  }
  const picked = [...bySlot.values()].sort((a, b) => (a.slotCode === null ? 1 : b.slotCode === null ? -1 : a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true })));
  const pending: Any[] = [];
  if (order.statusKey === 'open') {
    const open = (order.lines as Any[]).filter((l) => l.quantity > l.picked);
    const sorted = [...stock].filter((u) => u.statusKey === 'available').sort((a, b) => (a.testedAt ? 0 : 1) - (b.testedAt ? 0 : 1) || String(a.testedAt ?? '').localeCompare(String(b.testedAt ?? '')) || a.id - b.id);
    const used = new Set<number>();
    for (const l of open) {
      let remaining = l.quantity - l.picked;
      const fits = sorted.filter((u) => !used.has(u.id) && unitFitsLine(matchable(u), l));
      const groups = new Map<string, { slotCode: string | null; ids: number[] }>();
      for (const u of fits) {
        const k = u.slotCode ?? '';
        if (!groups.has(k)) groups.set(k, { slotCode: u.slotCode ?? null, ids: [] });
        groups.get(k)!.ids.push(u.id);
      }
      const ordered = [...groups.values()].sort((a, b) => (a.slotCode === null ? 1 : 0) - (b.slotCode === null ? 1 : 0) || b.ids.length - a.ids.length || (a.slotCode ?? '').localeCompare(b.slotCode ?? '', undefined, { numeric: true }));
      const where: Any[] = [];
      for (const g of ordered) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, g.ids.length);
        g.ids.slice(0, take).forEach((x) => used.add(x));
        where.push({ slotCode: g.slotCode, take, available: g.ids.length });
        remaining -= take;
      }
      pending.push({ lineId: l.id, lineNo: l.lineNo, equipmentTypeId: l.equipmentTypeId, specs: l.specs, quantity: l.quantity, picked: l.picked, remaining: l.quantity - l.picked, where, shortage: Math.max(0, remaining) });
    }
  }
  return { orderId: order.id, code: order.code, statusKey: order.statusKey, customerName: order.customerName, picked, pending };
}

// ---------------------------------------------------------------- búsqueda de equipos por código (escaneo)

/** Equipo por código completo, número de serie o forma corta ("1t120"). */
export function lookupUnit(live: Map<number, Any>, input: string): Any | undefined {
  const t = input.trim().toLowerCase();
  if (!t) return undefined;
  let hit: Any | undefined; let loose: Any | undefined;
  for (const u of [...live.values()].sort((a, b) => a.id - b.id)) {
    const code = String(u.code ?? '').toLowerCase();
    if (code === t) { hit = u; break; }
    if (!loose && ((u.serialNumber ?? '').toLowerCase() === t || code.endsWith(`-${t}`))) loose = u;
  }
  return hit ?? loose;
}

export async function localQuickCheck(codes: string[], st: State): Promise<Any> {
  const live = await liveUnits(st);
  const seen = new Set<number>();
  const results: Any[] = [];
  for (const input of codes) {
    const u = lookupUnit(live, input);
    if (!u) { results.push({ input, outcome: 'not_found' }); continue; }
    if (seen.has(u.id)) { results.push({ input, outcome: 'duplicate', code: u.code }); continue; }
    seen.add(u.id);
    if (u.statusKey !== 'available') { results.push({ input, outcome: 'not_available', code: u.code, status: u.statusKey }); continue; }
    results.push({ input, outcome: 'ok', code: u.code, unit: { ...u } });
  }
  return { results };
}

// ---------------------------------------------------------------- validación previa (mismos avisos que daría el servidor)

export async function validateOrder(kind: Op['kind'], path: string, body: Any, env: Env): Promise<void> {
  const { c } = env;
  const b = body ?? {};
  const partnerOk = (kindP: 'customers' | 'sellers', id: number | null | undefined, code: string) => {
    if (!id || id <= -TEMP_BASE) return;
    const rows = kindP === 'customers' ? c.customers : c.sellers;
    if (!rows.size) return;
    const r = partnerRow(env.st, c, kindP, id);
    if (!r || r.isActive === false) throw new ApiError(400, code);
  };
  const availableCheck = (ids: number[], lineCount: number) => {
    if (!lineCount) throw new ApiError(409, 'order_needs_lines');
    for (const id of ids) {
      const u = env.unit(id);
      if (!u) continue;
      if (u.statusKey !== 'available') throw new ApiError(409, 'unit_not_available', { code: u.code, status: u.statusKey });
    }
  };

  if (kind === 'order.create') {
    partnerOk('customers', b.customerId, 'invalid_customer');
    partnerOk('sellers', b.sellerId, 'invalid_seller');
    if (b.fromUnitIds?.length) availableCheck(b.fromUnitIds, 1);
    return;
  }
  if (kind === 'quick.sale') {
    partnerOk('customers', b.customerId, 'invalid_customer');
    partnerOk('sellers', b.sellerId, 'invalid_seller');
    for (const id of b.unitIds ?? []) {
      const u = env.unit(id);
      if (u && u.statusKey !== 'available') throw new ApiError(409, 'unit_not_available', { code: u.code, status: u.statusKey });
    }
    return;
  }
  const m = env.order(pathIds(path)[0]);
  if (!m) return;   // sin copia del pedido: lo decide el servidor al sincronizar
  if (kind === 'order.shipping') { if (m.statusKey === 'cancelled') throw new ApiError(409, 'order_cancelled'); return; }
  if (m.statusKey !== 'open') throw new ApiError(409, 'order_not_open');
  switch (kind) {
    case 'order.update': partnerOk('customers', b.customerId, 'invalid_customer'); partnerOk('sellers', b.sellerId, 'invalid_seller'); break;
    case 'order.items': availableCheck(b.unitIds ?? [], m.lines.length); if (b.lineId && !m.lines.some((l) => l.id === resolveId(b.lineId))) throw new ApiError(404, 'order_line_not_found'); break;
    case 'order.line_update': {
      const id = resolveId(pathIds(path)[1]);
      const l = m.lines.find((x) => x.id === id);
      if (!l) throw new ApiError(404, 'order_line_not_found');
      const picked = m.items.filter((i) => i.lineId === id).length;
      if (b.quantity < picked) throw new ApiError(409, 'line_quantity_below_picked', { picked });
      break;
    }
    case 'order.line_delete': if (!m.lines.some((l) => l.id === resolveId(pathIds(path)[1]))) throw new ApiError(404, 'order_line_not_found'); break;
    case 'order.complete':
      if (!m.items.length) throw new ApiError(409, 'order_empty');
      for (const i of m.items) { const u = env.unit(i.unitId); if (u && u.statusKey !== 'reserved') throw new ApiError(409, 'unit_not_reserved'); }
      break;
  }
}

// ---------------------------------------------------------------- preparar la acción antes de guardarla

export interface Prepared {
  kind: Op['kind']; path: string; body: Any; temp?: Temp;
  /** Respuesta a la pantalla (con el pedido ya actualizado) para las acciones que devuelven algo distinto al pedido. */
  respond?: (x: { op: Op; st: State; detail: Any }) => Any;
  /** No hay nada que guardar (p. ej. escanear códigos que no se pueden agregar): se responde directo. */
  done?: (detail: Any) => Any;
}

const jsonContains = (have: Any, want: Any): boolean => {
  if (want === null || typeof want !== 'object') return have === want || String(have).toLowerCase() === String(want).toLowerCase();
  if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h: Any) => jsonContains(h, w)));
  return have && typeof have === 'object' && Object.entries(want).every(([k, v]) => jsonContains(have[k], v));
};

const byOldest = (a: Any, b: Any) => (a.testedAt ? 0 : 1) - (b.testedAt ? 0 : 1) || String(a.testedAt ?? '').localeCompare(String(b.testedAt ?? '')) || a.id - b.id;

const withItems = (kind: Op['kind'], path: string, body: Any, unitIds: number[]): Prepared => {
  const ids = uniq(unitIds);
  return { kind, path, body, temp: { saleItems: ids.map(() => newTempId()), itemUnits: ids } };
};

/**
 * Convierte lo que pidió la persona en la acción que se guarda. "Agregar N equipos como estos", "completar la línea" y el escaneo
 * eligen los equipos aquí (los más antiguos disponibles) y se guardan como "agregar estos equipos", así al sincronizar se
 * reservan exactamente los mismos.
 */
export async function prepareOrder(kind: Op['kind'], path: string, body: Any, env: Env): Promise<Prepared | null> {
  const b = body ?? {};
  const can = overlaySession().can;
  const id = pathIds(path)[0];
  switch (kind) {
    case 'order.create': {
      const temp: Temp = { order: newTempId() };
      temp.code = `PEND-${tempNumber(temp.order!)}`;
      const groups = await groupsForUnits(b.fromUnitIds ?? [], env);
      temp.plan = { groups };
      temp.orderLines = [...(b.lines ?? []), ...groups].map(() => newTempId());
      const ids = uniq(b.fromUnitIds ?? []);
      temp.saleItems = ids.map(() => newTempId()); temp.itemUnits = ids;
      return { kind, path, body, temp };
    }
    case 'quick.sale': {
      const order = newTempId();
      return { kind, path, body, temp: { order, code: `PEND-${tempNumber(order)}` } };
    }
    case 'order.line_add': return { kind, path, body, temp: { orderLine: newTempId() } };
    case 'order.items': return withItems(kind, path, body, b.unitIds ?? []);
    case 'order.items_auto': {
      const live = await liveUnits(env.st);
      const rows = [...live.values()].filter((u) => u.statusKey === 'available' && u.equipmentTypeId === b.typeId && jsonContains(u.specs ?? {}, b.specs ?? {})
        && (!b.cosmeticGradeIds?.length || b.cosmeticGradeIds.includes(u.cosmeticGradeId)) && (!b.functionalGradeIds?.length || b.functionalGradeIds.includes(u.functionalGradeId))
        && (!b.lotId || u.lotId === b.lotId)).sort(byOldest).slice(0, b.quantity);
      if (rows.length < b.quantity) throw new ApiError(409, 'not_enough_units', { requested: b.quantity, available: rows.length });
      const p = withItems('order.items', path.replace(/\/auto$/, ''), { unitIds: rows.map((r) => r.id), unitPrice: can('sales.price') ? b.unitPrice ?? null : null }, rows.map((r) => r.id));
      return p;
    }
    case 'order.line_fill': {
      const m = env.order(id);
      if (!m) return null;
      const lineId = resolveId(pathIds(path)[1]);
      const line = linesOf(m).find((l) => l.id === lineId);
      if (!line) throw new ApiError(404, 'order_line_not_found');
      const need = line.quantity - line.picked;
      if (need <= 0) throw new ApiError(409, 'line_already_complete');
      const live = await liveUnits(env.st);
      const stock = [...live.values()].filter((u) => u.statusKey === 'available' && unitFitsLine(matchable(u), line)).sort(byOldest).slice(0, need);
      const extra = { filled: stock.length, missing: need - stock.length };
      if (!stock.length) return { kind: 'order.items', path, body: {}, done: (detail) => ({ ...detail, ...extra }) };
      const p = withItems('order.items', path.replace(/\/lines\/.*$/, '/items'), { unitIds: stock.map((u) => u.id), lineId }, stock.map((u) => u.id));
      p.respond = ({ detail }) => ({ ...detail, ...extra });
      return p;
    }
    case 'order.pick': {
      const m = env.order(id);
      if (!m) return null;
      const live = await liveUnits(env.st);
      const seen = new Set<number>();
      const toAdd: number[] = [];
      const results: Any[] = [];
      for (const input of b.codes ?? []) {
        const u = lookupUnit(live, input);
        if (!u) { results.push({ input, outcome: 'not_found' }); continue; }
        if (seen.has(u.id)) { results.push({ input, outcome: 'duplicate', unitId: u.id, code: u.code }); continue; }
        seen.add(u.id);
        if (m.items.some((i) => i.unitId === u.id)) { results.push({ input, outcome: 'already_in_order', unitId: u.id, code: u.code }); continue; }
        if (u.statusKey !== 'available') { results.push({ input, outcome: 'not_available', unitId: u.id, code: u.code, status: u.statusKey }); continue; }
        toAdd.push(u.id);
        results.push({ input, outcome: 'added', unitId: u.id, code: u.code });
      }
      const finish = (detail: Any, reserved: Reserved[]) => {
        const by = new Map(reserved.map((r) => [r.unitId, r]));
        for (const r of results) if (r.outcome === 'added') { const d = by.get(r.unitId); if (d) { r.match = d.status; r.lineId = d.lineId; } }
        return { results, order: detail };
      };
      if (!toAdd.length) return { kind: 'order.items', path, body: {}, done: (detail) => finish(detail, []) };
      if (!m.lines.length) throw new ApiError(409, 'order_needs_lines');
      const p = withItems('order.items', path.replace(/\/pick$/, '/items'), { unitIds: toAdd }, toAdd);
      p.respond = ({ op, st, detail }) => finish(detail, st.results.get(op.seq)?.reserved ?? []);
      return p;
    }
  }
  return null;
}

/** Líneas que se crean al abrir un pedido con equipos ya escogidos: una por tipo, características y grados iguales. */
async function groupsForUnits(unitIds: number[], env: Env): Promise<Any[]> {
  if (!unitIds.length) return [];
  const live = await liveUnits(env.st);
  const meta = env.c.meta;
  const keysOf = (typeId: number): string[] => {
    const t = meta?.equipmentTypes?.find((x: Any) => x.id === typeId);
    return (t?.attributes ?? []).filter((a: Any) => a.isActive && a.inLotLine).map((a: Any) => meta.attributes.find((d: Any) => d.id === a.attributeId)).filter((a: Any) => a?.isActive).map((a: Any) => a.key);
  };
  const groups = new Map<string, Any>();
  for (const id of uniq(unitIds).sort((a, b) => a - b)) {
    const u = live.get(resolveId(id));
    if (!u) continue;
    const specs: Record<string, unknown> = {};
    for (const k of keysOf(u.equipmentTypeId)) { const v = u.specs?.[k]; if (v !== undefined && v !== null && v !== '') specs[k] = v; }
    const cos = u.cosmeticGradeId ?? null, fun = u.functionalGradeId ?? null;
    const key = JSON.stringify([u.equipmentTypeId, specs, cos, fun]);
    const g = groups.get(key) ?? groups.set(key, { typeId: u.equipmentTypeId, specs, cos, fun, n: 0 }).get(key)!;
    g.n++;
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- respuestas

export function respondOrderKind(o: Op, st: State): Any | null {
  if (o.kind === 'order.create') return { id: o.temp!.order, code: o.temp!.code, pendingSync: true };
  if (o.kind === 'quick.sale') return { id: o.temp!.order, code: o.temp!.code, count: st.results.get(o.seq)?.count ?? 0, pendingSync: true };
  return null;
}

// ---------------------------------------------------------------- ids reales al sincronizar

/** Relaciona los ids provisionales de esta acción con los que creó el servidor (líneas y renglones incluidos). */
export async function learnOrderIds(op: Op, resp: Any, fetchOrder: (id: number) => Promise<Any | null>): Promise<[number, number][]> {
  const t = op.temp ?? {};
  const pairs: [number, number][] = [];
  const mapItems = (detail: Any) => {
    (t.saleItems ?? []).forEach((tid, i) => {
      const unit = resolveId(t.itemUnits?.[i] ?? 0);
      const real = (detail?.items ?? []).find((x: Any) => x.unitId === unit)?.id;
      if (real) pairs.push([tid, real]);
    });
  };
  if (op.kind === 'order.create') {
    if (t.order !== undefined && resp?.id) pairs.push([t.order, resp.id]);
    if (resp?.id && ((t.orderLines?.length ?? 0) || (t.saleItems?.length ?? 0))) {
      const d = await fetchOrder(resp.id);
      if (d) {
        const lines = [...(d.lines ?? [])].sort((a: Any, b: Any) => a.lineNo - b.lineNo);
        (t.orderLines ?? []).forEach((tid, i) => { if (lines[i]) pairs.push([tid, lines[i].id]); });
        mapItems(d);
      }
    }
  } else if (op.kind === 'quick.sale') {
    if (t.order !== undefined && resp?.id) pairs.push([t.order, resp.id]);
  } else if (op.kind === 'order.line_add') {
    const lines = [...(resp?.lines ?? [])];
    const last = lines.sort((a: Any, b: Any) => b.lineNo - a.lineNo)[0];
    if (t.orderLine !== undefined && last) pairs.push([t.orderLine, last.id]);
  } else if (op.kind === 'order.items') mapItems(resp);
  return pairs;
}
