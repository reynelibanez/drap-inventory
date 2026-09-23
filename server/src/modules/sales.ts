import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam, zPage } from '../http.js';
import { getSettings, nextOrderCode } from '../settings.js';
import { likeEscape, lockRows, sysItemId } from '../services/common.js';
import { notifyEvent } from '../services/notifications.js';
import { loadLines, matchUnit, unitFitsLine, type MatchStatus, type MatchableUnit, type OrderLine } from '../services/orderLines.js';
import { loadTypeAttrs, normalizeSpecs } from '../services/specs.js';
import { assertOrderVisible, ownOrdersFilter } from '../services/salesScope.js';
import { allocate, allocPlanSchema, distributeCents, type AllocTarget } from '../services/allocation.js';

async function loadOrder(c: Ctx, id: number, forUpdate = false) {
  if (forUpdate) await lockRows(c.db, 'sales_orders', [id]);
  const o = await c.db.opt<any>(
    `SELECT o.*, st.system_key AS status_key FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id
      WHERE o.id = $1`, [id]);
  if (!o) throw notFound('order_not_found');
  await assertOrderVisible(c, id);
  return o;
}

/** Datos de envío del pedido (bultos con peso y medidas), completando lo que falte. */
const shippingNum = z.number().min(0).max(1_000_000).nullable();
const shippingBody = z.object({
  weightUnit: z.enum(['lb', 'kg']),
  dimUnit: z.enum(['in', 'cm']),
  packages: z.array(z.object({ weight: shippingNum, length: shippingNum, width: shippingNum, height: shippingNum })).max(200),
});
type Shipping = z.infer<typeof shippingBody>;
function normalizeShipping(raw: unknown): Shipping {
  const r = shippingBody.safeParse(raw);
  if (r.success) return r.data;
  return { weightUnit: 'lb', dimUnit: 'in', packages: [] };
}

/** Descuentos y cargos del pedido: valor con signo (negativo = descuento). Los porcentajes son sobre el subtotal. */
const adjustmentSchema = z.object({
  label: z.string().trim().min(1).max(60),
  kind: z.enum(['percent', 'amount']),
  value: z.number().min(-1e9).max(1e9),
});
type Adjustment = z.infer<typeof adjustmentSchema>;
const money = (n: number) => Math.round(n * 100) / 100;

export function parseAdjustments(raw: unknown): Adjustment[] {
  const r = z.array(adjustmentSchema).safeParse(raw ?? []);
  return r.success ? r.data : [];
}
/** Subtotal + ajustes = total. Cada ajuste devuelve su monto ya calculado. */
export function applyAdjustments(subtotal: number, list: Adjustment[]) {
  const adjustments = list.map((a) => ({ ...a, amount: money(a.kind === 'percent' ? (subtotal * a.value) / 100 : a.value) }));
  return { adjustments, total: money(subtotal + adjustments.reduce((x, a) => x + a.amount, 0)) };
}
/** Subtotal que hace falta para llegar a un total dado (inverso de applyAdjustments). */
function subtotalForTotal(total: number, list: Adjustment[]): number {
  const amt = list.filter((a) => a.kind === 'amount').reduce((x, a) => x + a.value, 0);
  const pct = list.filter((a) => a.kind === 'percent').reduce((x, a) => x + a.value, 0);
  const den = 1 + pct / 100;
  if (den <= 0) throw badRequest('invalid_value');
  return Math.max(0, (total - amt) / den);
}

async function orderDetail(c: Ctx, id: number) {
  await assertOrderVisible(c, id);
  const canPrice = c.can('sales.price');
  const canCost = c.can('costs.view');
  const o = await c.db.opt<any>(
    `SELECT o.id, o.code, o.status_id AS "statusId", st.system_key AS "statusKey", o.customer_id AS "customerId", cu.name AS "customerName",
            cu.address AS "customerAddress", cu.phone AS "customerPhone", cu.contact_name AS "customerContact", cu.country AS "customerCountry",
            o.shipping, o.seller_id AS "sellerId", se.name AS "sellerName", o.is_quick AS "isQuick", o.currency, o.reserved_until AS "reservedUntil", o.notes,
            o.completed_at AS "completedAt", o.cancelled_at AS "cancelledAt", o.created_at AS "createdAt", o.adjustments AS "rawAdjustments"
       FROM sales_orders o
       JOIN catalog_items st ON st.id = o.status_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
       LEFT JOIN sellers se ON se.id = o.seller_id
      WHERE o.id = $1`, [id]);
  if (!o) throw notFound('order_not_found');
  const items = await c.db.rows<any>(
    `SELECT si.id, si.unit_id AS "unitId", ${canPrice ? 'si.unit_price' : 'NULL::numeric'} AS "unitPrice",
            ${canPrice ? 'u.list_price' : 'NULL::numeric'} AS "listPrice", ${canCost ? 'u.cost' : 'NULL::numeric'} AS "unitCost",
            u.code, u.serial_number AS "serialNumber", u.specs, u.equipment_type_id AS "equipmentTypeId",
            u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId", u.lot_id AS "lotId", l.code AS "lotCode",
            sl.code AS "slotCode", si.line_id AS "lineId", si.match_status AS "matchStatus"
       FROM sale_items si JOIN units u ON u.id = si.unit_id JOIN lots l ON l.id = u.lot_id LEFT JOIN slots sl ON sl.id = u.slot_id
      WHERE si.order_id = $1 AND si.released_at IS NULL ORDER BY si.id`, [id]);
  const subtotal = canPrice ? money(items.reduce((a, i) => a + (i.unitPrice ?? 0), 0)) : null;
  const adj = subtotal === null ? { adjustments: [] as ReturnType<typeof applyAdjustments>['adjustments'], total: null as number | null } : applyAdjustments(subtotal, parseAdjustments(o.rawAdjustments));
  // Ganancia estimada: lo vendido (menos descuentos) contra el costo de los equipos. Los cargos (envío, impuestos) no cuentan como ganancia.
  let margin: { cost: number; revenue: number; profit: number; pct: number | null; missing: number } | null = null;
  if (canPrice && canCost && subtotal !== null) {
    const cost = money(items.reduce((a, i) => a + (i.unitCost ?? 0), 0));
    const discounts = adj.adjustments.reduce((a, x) => a + Math.min(0, x.amount), 0);
    const revenue = money(subtotal + discounts);
    margin = { cost, revenue, profit: money(revenue - cost), pct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 10000) / 100 : null, missing: items.filter((i) => i.unitCost === null).length };
  }
  const lines = await loadLines(c.db, id);
  const open = o.statusKey === 'open';
  const stock = open ? await availableUnits(c, [...new Set(lines.map((l) => l.equipmentTypeId))]) : [];
  return {
    ...o, rawAdjustments: undefined, shipping: normalizeShipping(o.shipping), items, itemCount: items.length,
    subtotal, adjustments: adj.adjustments, total: adj.total, margin, canSeePrices: canPrice, canSeeCosts: canCost,
    lines: lines.map((l) => ({
      ...l, unitPrice: canPrice ? l.unitPrice : null,
      available: open ? stock.filter((u) => unitFitsLine(u, l)).length : 0,
    })),
    requested: lines.reduce((a, l) => a + l.quantity, 0),
    offOrder: items.filter((i) => i.matchStatus === 'no_match' || i.matchStatus === 'line_full').length,
  };
}

interface StockUnit extends MatchableUnit { code: string; slotId: number | null; slotCode: string | null; testedAt: string | null }

/** Equipos disponibles (vendibles) de los tipos indicados, del más antiguo al más nuevo. */
async function availableUnits(c: Ctx, typeIds: number[]): Promise<StockUnit[]> {
  if (!typeIds.length) return [];
  return c.db.rows<StockUnit>(
    `SELECT u.id, u.code, u.equipment_type_id AS "equipmentTypeId", u.specs, u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId",
            u.slot_id AS "slotId", sl.code AS "slotCode", u.tested_at AS "testedAt"
       FROM units u JOIN catalog_items st ON st.id = u.status_id LEFT JOIN slots sl ON sl.id = u.slot_id
      WHERE st.system_key = 'available' AND u.equipment_type_id = ANY($1::bigint[])
      ORDER BY u.tested_at NULLS LAST, u.id LIMIT 20000`, [typeIds]);
}

export interface Reserved { unitId: number; code: string; status: MatchStatus; lineId: number | null }

/**
 * Reserva unidades disponibles dentro de un pedido abierto. Todo o nada.
 * Cada equipo se asocia a la línea del pedido que le corresponde; si no le corresponde ninguna (o la línea
 * ya está completa) se agrega igual, pero se marca para avisar. `lineId` fuerza una línea concreta.
 */
async function reserveUnits(c: Ctx, orderId: number, orderCode: string, unitIds: number[], opts: { price?: number | null; lineId?: number | null } = {}): Promise<Reserved[]> {
  const ids = [...new Set(unitIds)].sort((a, b) => a - b);
  await lockRows(c.db, 'units', ids);
  const units = await c.db.rows<MatchableUnit & { code: string; status_key: string; listPrice: number | null }>(
    `SELECT u.id, u.code, st.system_key AS status_key, u.equipment_type_id AS "equipmentTypeId", u.specs,
            u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId", u.list_price AS "listPrice"
       FROM units u JOIN catalog_items st ON st.id = u.status_id
      WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [ids]);
  if (units.length !== ids.length) throw notFound('unit_not_found');
  for (const u of units) if (u.status_key !== 'available') throw conflict('unit_not_available', { code: u.code, status: u.status_key });
  const lines = await loadLines(c.db, orderId);
  // Un pedido sin líneas (sin indicar qué se vende) no admite equipos: primero se define lo que se pide.
  if (!lines.length) throw conflict('order_needs_lines');
  const taken = new Map<number, number>();
  const reserved = await sysItemId(c.db, 'unit_status', 'reserved');
  const out: Reserved[] = [];
  for (const u of units) {
    let line: OrderLine | null; let status: MatchStatus;
    if (opts.lineId) { line = lines.find((l) => l.id === opts.lineId) ?? null; status = 'ok'; if (!line) throw notFound('order_line_not_found'); }
    else ({ line, status } = matchUnit(u, lines, taken));
    if (line) taken.set(line.id, (taken.get(line.id) ?? 0) + 1);
    // Precio: el indicado al agregar, si no el de la línea del pedido, si no el precio de lista del equipo.
    const price = opts.price ?? line?.unitPrice ?? u.listPrice ?? null;
    await c.db.query('INSERT INTO sale_items (company_id, order_id, unit_id, unit_price, line_id, match_status) VALUES ($1,$2,$3,$4,$5,$6)',
      [c.companyId, orderId, u.id, price, line?.id ?? null, opts.lineId ? 'ok' : status]);
    await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1', [u.id, reserved]);
    await c.audit('unit.reserved', 'unit', u.id, { orderId, orderCode, match: status });
    out.push({ unitId: u.id, code: u.code, status, lineId: line?.id ?? null });
  }
  return out;
}

/** Libera items de un pedido: la unidad vuelve a estar disponible. */
export async function releaseItems(c: { db: Ctx['db']; audit: Ctx['audit'] }, itemIds: number[], reason: string) {
  if (!itemIds.length) return 0;
  const rows = await c.db.rows<{ unit_id: number }>(
    `UPDATE sale_items SET released_at = now() WHERE id = ANY($1::bigint[]) AND released_at IS NULL RETURNING unit_id`, [itemIds]);
  if (!rows.length) return 0;
  const available = await sysItemId(c.db, 'unit_status', 'available');
  const reserved = await sysItemId(c.db, 'unit_status', 'reserved');
  for (const r of rows) {
    await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1 AND status_id = $3', [r.unit_id, available, reserved]);
    await c.audit('unit.released', 'unit', r.unit_id, { reason });
  }
  return rows.length;
}

/**
 * Listado para preparar el pedido:
 *  - `picked`: los equipos ya agregados, agrupados por ubicación (dónde están).
 *  - `pending`: por cada línea que aún no se completa, en qué ubicaciones hay equipos disponibles que le sirven
 *    (se propone tomar primero de donde hay más juntos) y cuántos faltan sin stock.
 */
export async function pickList(c: Ctx, orderId: number) {
  const order = await orderDetail(c, orderId);
  const bySlot = new Map<string, { slotCode: string | null; units: { code: string; serialNumber: string | null; equipmentTypeId: number; specs: unknown; lineNo: number | null; matchStatus: string | null }[] }>();
  const lineNo = new Map<number, number>(order.lines.map((l: any) => [l.id as number, l.lineNo as number]));
  for (const i of order.items as any[]) {
    const k = i.slotCode ?? '';
    if (!bySlot.has(k)) bySlot.set(k, { slotCode: i.slotCode, units: [] });
    bySlot.get(k)!.units.push({ code: i.code, serialNumber: i.serialNumber, equipmentTypeId: i.equipmentTypeId, specs: i.specs, lineNo: i.lineId ? lineNo.get(i.lineId) ?? null : null, matchStatus: i.matchStatus });
  }
  const picked = [...bySlot.values()].sort((a, b) => (a.slotCode === null ? 1 : b.slotCode === null ? -1 : a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true })));

  const pending: { lineId: number; lineNo: number; equipmentTypeId: number; specs: unknown; quantity: number; picked: number; remaining: number; where: { slotCode: string | null; take: number; available: number }[]; shortage: number }[] = [];
  if (order.statusKey === 'open') {
    const open = (order.lines as any[]).filter((l) => l.quantity > l.picked);
    const stock = await availableUnits(c, [...new Set(open.map((l) => l.equipmentTypeId))]);
    const used = new Set<number>(); // un mismo equipo no se propone para dos líneas
    for (const l of open) {
      let remaining = l.quantity - l.picked;
      const fits = stock.filter((u) => !used.has(u.id) && unitFitsLine(u, l));
      const groups = new Map<string, { slotCode: string | null; ids: number[] }>();
      for (const u of fits) {
        const k = u.slotCode ?? '';
        if (!groups.has(k)) groups.set(k, { slotCode: u.slotCode, ids: [] });
        groups.get(k)!.ids.push(u.id);
      }
      // Primero las ubicaciones con más equipos que sirven (menos recorrido); sin ubicar al final.
      const ordered = [...groups.values()].sort((a, b) => (a.slotCode === null ? 1 : 0) - (b.slotCode === null ? 1 : 0) || b.ids.length - a.ids.length || (a.slotCode ?? '').localeCompare(b.slotCode ?? '', undefined, { numeric: true }));
      const where: { slotCode: string | null; take: number; available: number }[] = [];
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
  return { orderId, code: order.code, statusKey: order.statusKey, customerName: order.customerName, picked, pending };
}

export async function salesRoutes(app: FastifyInstance) {
  // ---------- Listado ----------
  app.get('/api/orders', route('sales.view', async (c) => {
    const q = c.query(zPage.extend({ statusKey: z.string().max(30).optional(), customerId: zId.optional(), sellerId: zId.optional() }));
    const p: unknown[] = [];
    const where: string[] = [];
    if (q.q) { p.push(`%${likeEscape(q.q)}%`); where.push(`(o.code ILIKE $${p.length} OR cu.name ILIKE $${p.length})`); }
    if (q.statusKey) { p.push(q.statusKey); where.push(`st.system_key = $${p.length}`); }
    if (q.customerId) { p.push(q.customerId); where.push(`o.customer_id = $${p.length}`); }
    if (q.sellerId) { p.push(q.sellerId); where.push(`o.seller_id = $${p.length}`); }
    // Sin "ver las ventas de todos": solo los pedidos propios.
    const own = ownOrdersFilter(c);
    if (own) where.push(own);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = `FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id LEFT JOIN customers cu ON cu.id = o.customer_id LEFT JOIN sellers se ON se.id = o.seller_id ${w}`;
    const total = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n ${from}`, p)).n;
    const canPrice = c.can('sales.price');
    const items = await c.db.rows(
      `SELECT o.id, o.code, o.status_id AS "statusId", st.system_key AS "statusKey", cu.name AS "customerName", se.name AS "sellerName",
              o.currency, o.reserved_until AS "reservedUntil", o.created_at AS "createdAt", o.completed_at AS "completedAt", o.is_quick AS "isQuick",
              (SELECT count(*) FROM order_lines ol WHERE ol.order_id = o.id)::int AS "lineCount",
              (SELECT count(*) FROM sale_items si WHERE si.order_id = o.id AND si.released_at IS NULL)::int AS "itemCount",
              ${canPrice ? '(SELECT COALESCE(sum(si.unit_price), 0) FROM sale_items si WHERE si.order_id = o.id AND si.released_at IS NULL)' : 'NULL::numeric'} AS subtotal,
              o.adjustments AS "rawAdjustments"
         ${from} ORDER BY o.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    for (const it of items as any[]) {
      it.total = it.subtotal === null ? null : applyAdjustments(it.subtotal, parseAdjustments(it.rawAdjustments)).total;
      delete it.rawAdjustments;
    }
    return { items, total };
  }));

  app.get('/api/orders/:id', route('sales.view', async (c) => orderDetail(c, c.params(zIdParam).id)));

  // ---------- Alta y edición ----------
  app.post('/api/orders', route('sales.create', async (c) => {
    const b = c.body(z.object({
      customerId: zId, sellerId: zId.nullish(), notes: z.string().trim().max(1000).nullish(),
      reservedUntil: z.string().datetime().nullish(),
      // Equipos ya escogidos (p. ej. desde Inventario): el pedido nace con una línea por cada tipo/característica/grado y los reserva.
      fromUnitIds: z.array(zId).max(2000).optional(),
      lines: z.array(z.object({
        equipmentTypeId: zId, specs: z.record(z.string(), z.unknown()).default({}), cosmeticGradeIds: z.array(zId).default([]),
        functionalGradeIds: z.array(zId).default([]), quantity: z.number().int().min(1).max(100000), unitPrice: z.number().min(0).max(100_000_000).nullish(), notes: z.string().trim().max(500).nullish(),
      })).max(200).default([]),
    }));
    if (!(await c.db.opt('SELECT 1 FROM customers WHERE id = $1 AND is_active', [b.customerId]))) throw badRequest('invalid_customer');
    if (b.sellerId && !(await c.db.opt('SELECT 1 FROM sellers WHERE id = $1 AND is_active', [b.sellerId]))) throw badRequest('invalid_seller');
    const settings = await getSettings(c.db, c.companyId);
    const code = await nextOrderCode(c.db, settings, new Date());
    const status = await sysItemId(c.db, 'order_status', 'open');
    const company = await c.db.one<{ currency: string }>('SELECT currency FROM companies WHERE id = $1', [c.companyId]);
    const until = b.reservedUntil ?? (settings.reservationDays ? new Date(Date.now() + settings.reservationDays * 86400_000).toISOString() : null);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO sales_orders (company_id, code, customer_id, seller_id, status_id, currency, reserved_until, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.companyId, code, b.customerId, b.sellerId ?? null, status, company.currency, until, b.notes ?? null, c.userId]);
    for (const l of b.lines) await insertLine(c, r.id, l);
    if (b.fromUnitIds?.length) {
      const ids = [...new Set(b.fromUnitIds)].sort((x, y) => x - y);
      const units = await c.db.rows<{ id: number; typeId: number; specs: Record<string, unknown>; cos: number | null; fun: number | null }>(
        `SELECT id, equipment_type_id AS "typeId", specs, cosmetic_grade_id AS cos, functional_grade_id AS fun FROM units WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids]);
      if (units.length !== ids.length) throw notFound('unit_not_found');
      const keysByType = new Map<number, string[]>();
      const groups = new Map<string, { typeId: number; specs: Record<string, unknown>; cos: number | null; fun: number | null; n: number }>();
      for (const u of units) {
        if (!keysByType.has(u.typeId)) keysByType.set(u.typeId, (await loadTypeAttrs(c.db, u.typeId)).filter((a) => a.inLotLine).map((a) => a.key));
        const specs: Record<string, unknown> = {};
        for (const k of keysByType.get(u.typeId)!) if (u.specs?.[k] !== undefined && u.specs[k] !== null && u.specs[k] !== '') specs[k] = u.specs[k];
        const key = JSON.stringify([u.typeId, specs, u.cos, u.fun]);
        const g = groups.get(key) ?? groups.set(key, { typeId: u.typeId, specs, cos: u.cos, fun: u.fun, n: 0 }).get(key)!;
        g.n++;
      }
      for (const g of groups.values()) {
        await insertLine(c, r.id, { equipmentTypeId: g.typeId, specs: g.specs, cosmeticGradeIds: g.cos ? [g.cos] : [], functionalGradeIds: g.fun ? [g.fun] : [], quantity: g.n });
      }
      await reserveUnits(c, r.id, code, ids, {});
    }
    await c.audit('order.created', 'order', r.id, { code, lines: b.lines.length });
    const customer = await c.db.opt<{ name: string }>('SELECT name FROM customers WHERE id = $1', [b.customerId]);
    await notifyEvent(c.db, c.companyId, 'order_created', { id: r.id, code, customer: customer?.name }, { actorUserId: c.userId, orderId: r.id });
    return { id: r.id, code };
  }));

  app.patch('/api/orders/:id', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      customerId: zId.optional(), sellerId: zId.nullable().optional(), notes: z.string().trim().max(1000).nullable().optional(),
      reservedUntil: z.string().datetime().nullable().optional(),
    }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    if (b.customerId && !(await c.db.opt('SELECT 1 FROM customers WHERE id = $1 AND is_active', [b.customerId]))) throw badRequest('invalid_customer');
    if (b.sellerId && !(await c.db.opt('SELECT 1 FROM sellers WHERE id = $1 AND is_active', [b.sellerId]))) throw badRequest('invalid_seller');
    await c.db.query(
      `UPDATE sales_orders SET customer_id = COALESCE($2, customer_id),
              seller_id = CASE WHEN $3::boolean THEN $4 ELSE seller_id END,
              notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
              reserved_until = CASE WHEN $7::boolean THEN $8::timestamptz ELSE reserved_until END,
              expiry_notified_at = CASE WHEN $7::boolean THEN NULL ELSE expiry_notified_at END
        WHERE id = $1`,
      [id, b.customerId ?? null, b.sellerId !== undefined, b.sellerId ?? null, b.notes !== undefined, b.notes ?? null, b.reservedUntil !== undefined, b.reservedUntil ?? null]);
    await c.audit('order.updated', 'order', id);
    return orderDetail(c, id);
  }));

  // Datos de envío (bultos, peso y medidas) para las etiquetas del pedido. Se pueden completar aun con el pedido ya cerrado.
  app.put('/api/orders/:id/shipping', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(shippingBody);
    const o = await loadOrder(c, id, true);
    if (o.status_key === 'cancelled') throw conflict('order_cancelled');
    await c.db.query('UPDATE sales_orders SET shipping = $2 WHERE id = $1', [id, JSON.stringify(b)]);
    await c.audit('order.shipping_updated', 'order', id, { orderCode: o.code, packages: b.packages.length });
    return orderDetail(c, id);
  }));

  // ---------- Equipos del pedido ----------
  app.post('/api/orders/:id/items', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    // `lineId`: los equipos van a esa línea sin buscarla (lo usa el envío de lo que se completó sin conexión).
    const b = c.body(z.object({ unitIds: z.array(zId).min(1).max(1000), unitPrice: z.number().min(0).nullish(), lineId: zId.nullish() }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const price = c.can('sales.price') ? (b.unitPrice ?? null) : null;
    await reserveUnits(c, id, o.code, b.unitIds, { price, lineId: b.lineId ?? null });
    return orderDetail(c, id);
  }));

  /** "Agrega N equipos como estos": elige los disponibles más antiguos que cumplan el filtro. */
  app.post('/api/orders/:id/items/auto', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      typeId: zId,
      specs: z.record(z.string(), z.unknown()).default({}),
      cosmeticGradeIds: z.array(zId).default([]),
      functionalGradeIds: z.array(zId).default([]),
      lotId: zId.nullish(),
      quantity: z.number().int().min(1).max(5000),
      unitPrice: z.number().min(0).nullish(),
    }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const rows = await c.db.rows<{ id: number }>(
      `SELECT u.id FROM units u JOIN catalog_items st ON st.id = u.status_id
        WHERE st.system_key = 'available' AND u.equipment_type_id = $1 AND u.specs @> $2::jsonb
          AND (cardinality($3::bigint[]) = 0 OR u.cosmetic_grade_id = ANY($3::bigint[]))
          AND (cardinality($4::bigint[]) = 0 OR u.functional_grade_id = ANY($4::bigint[]))
          AND ($5::bigint IS NULL OR u.lot_id = $5)
        ORDER BY u.tested_at NULLS LAST, u.id
        LIMIT $6 FOR UPDATE OF u SKIP LOCKED`,
      [b.typeId, JSON.stringify(b.specs), b.cosmeticGradeIds, b.functionalGradeIds, b.lotId ?? null, b.quantity]);
    if (rows.length < b.quantity) throw conflict('not_enough_units', { requested: b.quantity, available: rows.length });
    const price = c.can('sales.price') ? (b.unitPrice ?? null) : null;
    await reserveUnits(c, id, o.code, rows.map((r) => r.id), { price });
    return orderDetail(c, id);
  }));

  app.post('/api/orders/:id/items/remove', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const { itemIds } = c.body(z.object({ itemIds: z.array(zId).min(1).max(5000) }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const own = await c.db.rows<{ id: number }>('SELECT id FROM sale_items WHERE order_id = $1 AND id = ANY($2::bigint[]) AND released_at IS NULL', [id, itemIds]);
    await releaseItems(c, own.map((r) => r.id), 'removed_from_order');
    return orderDetail(c, id);
  }));

  app.post('/api/orders/:id/prices', route('sales.price', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.union([
      z.object({ itemIds: z.array(zId).optional(), unitPrice: z.number().min(0).max(100_000_000).nullable() }),
      z.object({ prices: z.array(z.object({ itemId: zId, unitPrice: z.number().min(0).max(100_000_000).nullable() })).min(1).max(5000) }),
    ]));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    if ('prices' in b) {
      for (const p of b.prices) await c.db.query('UPDATE sale_items SET unit_price = $3 WHERE id = $1 AND order_id = $2 AND released_at IS NULL', [p.itemId, id, p.unitPrice]);
    } else {
      await c.db.query(
        `UPDATE sale_items SET unit_price = $2 WHERE order_id = $1 AND released_at IS NULL AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))`,
        [id, b.unitPrice, b.itemIds ?? null]);
    }
    await c.audit('order.prices_set', 'order', id);
    return orderDetail(c, id);
  }));

  // ---------- Descuentos y cargos del pedido ----------
  app.put('/api/orders/:id/adjustments', route('sales.price', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ adjustments: z.array(adjustmentSchema).max(20) }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    await c.db.query('UPDATE sales_orders SET adjustments = $2 WHERE id = $1', [id, JSON.stringify(b.adjustments)]);
    await c.audit('order.adjustments_set', 'order', id, { count: b.adjustments.length });
    return orderDetail(c, id);
  }));

  // ---------- Precio total del pedido repartido entre sus equipos ----------
  const pricePlanBody = z.object({
    /** subtotal = suma de los equipos · total = total final del pedido (con sus descuentos y cargos) */
    target: z.enum(['subtotal', 'total']).default('subtotal'),
    amount: z.number().min(0).max(1e10),
    plan: allocPlanSchema,
    /** Solo estos equipos (el monto es lo que suman ellos). */
    itemIds: z.array(zId).max(5000).optional(),
  });

  async function pricePlan(c: Ctx, orderId: number, b: z.infer<typeof pricePlanBody>, save: boolean) {
    const o = await loadOrder(c, orderId, save);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    // Repartir según el costo revelaría el costo de los equipos: solo quien puede verlos.
    if (b.plan.base === 'by_cost' || b.plan.rules.some((r) => r.enabled && r.method === 'by_cost')) c.need('costs.view');
    const rows = await c.db.rows<any>(
      `SELECT si.id, si.line_id AS "lineId", si.unit_price AS "unitPrice", u.code, u.equipment_type_id AS "typeId", u.specs,
              u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId", u.list_price AS "listPrice", u.cost
         FROM sale_items si JOIN units u ON u.id = si.unit_id
        WHERE si.order_id = $1 AND si.released_at IS NULL AND ($2::bigint[] IS NULL OR si.id = ANY($2::bigint[])) ORDER BY si.id`, [orderId, b.itemIds ?? null]);
    if (!rows.length) throw conflict('order_empty');
    const adjustments = parseAdjustments(o.adjustments);
    if (b.target === 'total' && b.itemIds) throw badRequest('invalid_value');
    const pool = b.target === 'total' ? subtotalForTotal(b.amount, adjustments) : b.amount;
    const targets: AllocTarget[] = rows.map((r) => ({
      key: `i:${r.id}`, qty: 1, typeId: r.typeId, specs: r.specs ?? {}, lineId: r.lineId, cosmeticGradeId: r.cosmeticGradeId, functionalGradeId: r.functionalGradeId,
      list: r.listPrice, cost: r.cost,
    }));
    const result = allocate({ pool, targets, rules: b.plan.rules, base: b.plan.base });
    const raw = targets.map((t) => result.perUnit.get(t.key) ?? 0);
    // Si todo el monto quedó repartido, los renglones suman EXACTAMENTE el total (los centavos sobrantes se reparten entre ellos).
    const complete = Math.abs(result.summary.difference) < 0.005;
    const prices = complete ? distributeCents(raw, result.summary.assigned) : raw.map(money);
    const canCost = c.can('costs.view');
    if (save) {
      for (let i = 0; i < rows.length; i++) await c.db.query('UPDATE sale_items SET unit_price = $2 WHERE id = $1', [rows[i].id, prices[i]]);
      await c.audit('order.price_plan_applied', 'order', orderId, { target: b.target, amount: b.amount, items: rows.length, rules: b.plan.rules.length });
    }
    const subtotal = money(prices.reduce((a, x) => a + x, 0));
    return {
      items: rows.map((r, i) => ({ itemId: r.id, code: r.code, price: prices[i], previous: r.unitPrice, listPrice: r.listPrice, cost: canCost ? r.cost : null, ruleId: result.ruleOf.get(`i:${r.id}`) ?? null })),
      summary: result.summary, warnings: result.warnings, subtotal,
      total: applyAdjustments(subtotal, adjustments).total,
    };
  }

  app.post('/api/orders/:id/price-plan/preview', route('sales.price', async (c) => pricePlan(c, c.params(zIdParam).id, c.body(pricePlanBody), false)));
  app.post('/api/orders/:id/price-plan/apply', route('sales.price', async (c) => {
    const { id } = c.params(zIdParam);
    await pricePlan(c, id, c.body(pricePlanBody), true);
    return orderDetail(c, id);
  }));


  // ---------- Líneas del pedido (qué se pide, sin códigos) ----------
  const lineBody = z.object({
    equipmentTypeId: zId,
    specs: z.record(z.string(), z.unknown()).default({}),
    cosmeticGradeIds: z.array(zId).max(100).default([]),
    functionalGradeIds: z.array(zId).max(100).default([]),
    quantity: z.number().int().min(1).max(100000),
    unitPrice: z.number().min(0).max(100_000_000).nullish(),
    notes: z.string().trim().max(500).nullish(),
  });
  type LineBody = z.infer<typeof lineBody>;

  async function cleanLine(c: Ctx, b: LineBody) {
    const type = await c.db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [b.equipmentTypeId]);
    if (!type || !type.is_active) throw badRequest('invalid_equipment_type');
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'draft');
    for (const [ids, cat, field] of [[b.cosmeticGradeIds, 'cosmetic_grade', 'cosmeticGradeIds'], [b.functionalGradeIds, 'functional_grade', 'functionalGradeIds']] as const) {
      const uniq = [...new Set(ids)];
      if (!uniq.length) continue;
      const n = (await c.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM catalog_items ci JOIN catalogs ca ON ca.id = ci.catalog_id WHERE ca.key = $1 AND ci.id = ANY($2::bigint[])`, [cat, uniq])).n;
      if (n !== uniq.length) throw badRequest('invalid_catalog_value', { field });
    }
    return specs;
  }

  async function insertLine(c: Ctx, orderId: number, b: LineBody) {
    const specs = await cleanLine(c, b);
    const price = c.can('sales.price') ? b.unitPrice ?? null : null;
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO order_lines (company_id, order_id, line_no, equipment_type_id, specs, cosmetic_grade_ids, functional_grade_ids, quantity, unit_price, notes)
       VALUES ($1,$2,(SELECT COALESCE(max(line_no), 0) + 1 FROM order_lines WHERE order_id = $2),$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [c.companyId, orderId, b.equipmentTypeId, JSON.stringify(specs), [...new Set(b.cosmeticGradeIds)], [...new Set(b.functionalGradeIds)], b.quantity, price, b.notes ?? null]);
    return r.id;
  }

  app.post('/api/orders/:id/lines', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(lineBody);
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const lineId = await insertLine(c, id, b);
    await c.audit('order.line_added', 'order', id, { lineId, quantity: b.quantity });
    return orderDetail(c, id);
  }));

  app.put('/api/orders/:id/lines/:lineId', route('sales.edit', async (c) => {
    const { id, lineId } = c.params(z.object({ id: zId, lineId: zId }));
    const b = c.body(lineBody);
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const cur = await c.db.opt<{ picked: number; unit_price: number | null }>(
      `SELECT (SELECT count(*) FROM sale_items si WHERE si.line_id = l.id AND si.released_at IS NULL)::int AS picked, l.unit_price
         FROM order_lines l WHERE l.id = $1 AND l.order_id = $2`, [lineId, id]);
    if (!cur) throw notFound('order_line_not_found');
    if (b.quantity < cur.picked) throw conflict('line_quantity_below_picked', { picked: cur.picked });
    const specs = await cleanLine(c, b);
    const price = c.can('sales.price') ? b.unitPrice ?? null : cur.unit_price;
    await c.db.query(
      `UPDATE order_lines SET equipment_type_id = $3, specs = $4, cosmetic_grade_ids = $5, functional_grade_ids = $6, quantity = $7, unit_price = $8, notes = $9
        WHERE id = $1 AND order_id = $2`,
      [lineId, id, b.equipmentTypeId, JSON.stringify(specs), [...new Set(b.cosmeticGradeIds)], [...new Set(b.functionalGradeIds)], b.quantity, price, b.notes ?? null]);
    await c.audit('order.line_updated', 'order', id, { lineId });
    return orderDetail(c, id);
  }));

  app.delete('/api/orders/:id/lines/:lineId', route('sales.edit', async (c) => {
    const { id, lineId } = c.params(z.object({ id: zId, lineId: zId }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    if (!(await c.db.opt('SELECT 1 FROM order_lines WHERE id = $1 AND order_id = $2', [lineId, id]))) throw notFound('order_line_not_found');
    // Los equipos ya agregados se quedan en el pedido, pero sin línea (se marcarán como "no coincide").
    await c.db.query("UPDATE sale_items SET line_id = NULL, match_status = 'no_match' WHERE line_id = $1 AND released_at IS NULL", [lineId]);
    await c.db.query('UPDATE sale_items SET line_id = NULL WHERE line_id = $1', [lineId]);
    await c.db.query('DELETE FROM order_lines WHERE id = $1', [lineId]);
    await c.audit('order.line_removed', 'order', id, { lineId });
    return orderDetail(c, id);
  }));

  /** Reserva automáticamente (los más antiguos) los equipos que faltan de una línea. Reserva los que haya, aunque no alcancen. */
  app.post('/api/orders/:id/lines/:lineId/fill', route('sales.edit', async (c) => {
    const { id, lineId } = c.params(z.object({ id: zId, lineId: zId }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const line = (await loadLines(c.db, id)).find((l) => l.id === lineId);
    if (!line) throw notFound('order_line_not_found');
    const need = line.quantity - line.picked;
    if (need <= 0) throw conflict('line_already_complete');
    const stock = (await availableUnits(c, [line.equipmentTypeId])).filter((u) => unitFitsLine(u, line)).slice(0, need);
    if (stock.length) await reserveUnits(c, id, o.code, stock.map((u) => u.id), { lineId });
    return { ...(await orderDetail(c, id)), filled: stock.length, missing: need - stock.length };
  }));

  // ---------- Agregar equipos escogidos del rack por código (escaneo) ----------
  app.post('/api/orders/:id/pick', route('sales.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const { codes } = c.body(z.object({ codes: z.array(z.string().trim().min(1).max(100)).min(1).max(2000) }));
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');

    type Outcome = 'added' | 'already_in_order' | 'not_found' | 'not_available' | 'duplicate';
    const results: { input: string; outcome: Outcome; unitId?: number; code?: string; status?: string; match?: MatchStatus; lineId?: number | null }[] = [];
    const seen = new Set<number>();
    const toAdd: { input: string; unitId: number }[] = [];
    for (const input of codes) {
      const u = await c.db.opt<{ id: number; code: string; status_key: string; order_id: number | null }>(
        `SELECT u.id, u.code, st.system_key AS status_key,
                (SELECT si.order_id FROM sale_items si WHERE si.unit_id = u.id AND si.released_at IS NULL LIMIT 1) AS order_id
           FROM units u JOIN catalog_items st ON st.id = u.status_id
          WHERE lower(u.code) = lower($1) OR lower(u.serial_number) = lower($1) OR lower(u.code) LIKE '%-' || lower($2)
          ORDER BY (lower(u.code) = lower($1)) DESC LIMIT 1`, [input, likeEscape(input)]);
      if (!u) { results.push({ input, outcome: 'not_found' }); continue; }
      if (seen.has(u.id)) { results.push({ input, outcome: 'duplicate', unitId: u.id, code: u.code }); continue; }
      seen.add(u.id);
      if (u.order_id === id) { results.push({ input, outcome: 'already_in_order', unitId: u.id, code: u.code }); continue; }
      if (u.status_key !== 'available') { results.push({ input, outcome: 'not_available', unitId: u.id, code: u.code, status: u.status_key }); continue; }
      toAdd.push({ input, unitId: u.id });
      results.push({ input, outcome: 'added', unitId: u.id, code: u.code });
    }
    if (toAdd.length) {
      // Se agregan aunque no coincidan con el pedido: solo se marcan para avisar.
      const done = await reserveUnits(c, id, o.code, toAdd.map((t) => t.unitId), {});
      const byUnit = new Map(done.map((d) => [d.unitId, d]));
      for (const r of results) if (r.outcome === 'added') { const d = byUnit.get(r.unitId!)!; r.match = d.status; r.lineId = d.lineId; }
    }
    return { results, order: await orderDetail(c, id) };
  }));

  // ---------- Listado de dónde están los equipos del pedido ----------
  app.get('/api/orders/:id/pick-list', route('sales.view', async (c) => pickList(c, c.params(zIdParam).id)));

  // ---------- Venta rápida: vender equipos sin pedido ni cliente ----------
  /** Resuelve códigos (o series) a equipos y dice si se pueden vender. No guarda nada. */
  app.post('/api/quick-sales/check', route('sales.complete', async (c) => {
    c.need('sales.create');
    const { codes } = c.body(z.object({ codes: z.array(z.string().trim().min(1).max(100)).min(1).max(2000) }));
    type Outcome = 'ok' | 'not_found' | 'not_available' | 'duplicate';
    const results: { input: string; outcome: Outcome; unit?: unknown; code?: string; status?: string }[] = [];
    const seen = new Set<number>();
    for (const input of codes) {
      const u = await c.db.opt<any>(
        `SELECT u.id, u.code, u.serial_number AS "serialNumber", u.specs, u.equipment_type_id AS "equipmentTypeId",
                u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId", u.lot_id AS "lotId", l.code AS "lotCode",
                sl.code AS "slotCode", st.system_key AS "statusKey"
           FROM units u JOIN catalog_items st ON st.id = u.status_id JOIN lots l ON l.id = u.lot_id LEFT JOIN slots sl ON sl.id = u.slot_id
          WHERE lower(u.code) = lower($1) OR lower(u.serial_number) = lower($1) OR lower(u.code) LIKE '%-' || lower($2)
          ORDER BY (lower(u.code) = lower($1)) DESC LIMIT 1`, [input, likeEscape(input)]);
      if (!u) { results.push({ input, outcome: 'not_found' }); continue; }
      if (seen.has(u.id)) { results.push({ input, outcome: 'duplicate', code: u.code }); continue; }
      seen.add(u.id);
      if (u.statusKey !== 'available') { results.push({ input, outcome: 'not_available', code: u.code, status: u.statusKey }); continue; }
      results.push({ input, outcome: 'ok', code: u.code, unit: u });
    }
    return { results };
  }));

  /** Registra la venta ya completada: los equipos pasan a Vendido. Cliente, vendedor y notas son opcionales. */
  app.post('/api/quick-sales', route('sales.complete', async (c) => {
    c.need('sales.create');
    const b = c.body(z.object({
      unitIds: z.array(zId).min(1).max(2000),
      customerId: zId.nullish(), sellerId: zId.nullish(), notes: z.string().trim().max(1000).nullish(),
      unitPrice: z.number().min(0).max(100_000_000).nullish(),
    }));
    if (b.customerId && !(await c.db.opt('SELECT 1 FROM customers WHERE id = $1 AND is_active', [b.customerId]))) throw badRequest('invalid_customer');
    if (b.sellerId && !(await c.db.opt('SELECT 1 FROM sellers WHERE id = $1 AND is_active', [b.sellerId]))) throw badRequest('invalid_seller');
    const ids = [...new Set(b.unitIds)].sort((x, y) => x - y);
    await lockRows(c.db, 'units', ids);
    const units = await c.db.rows<{ id: number; code: string; status_key: string; list_price: number | null }>(
      `SELECT u.id, u.code, st.system_key AS status_key, u.list_price FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [ids]);
    if (units.length !== ids.length) throw notFound('unit_not_found');
    for (const u of units) if (u.status_key !== 'available') throw conflict('unit_not_available', { code: u.code, status: u.status_key });

    const settings = await getSettings(c.db, c.companyId);
    const code = await nextOrderCode(c.db, settings, new Date());
    const status = await sysItemId(c.db, 'order_status', 'completed');
    const sold = await sysItemId(c.db, 'unit_status', 'sold');
    const company = await c.db.one<{ currency: string }>('SELECT currency FROM companies WHERE id = $1', [c.companyId]);
    const price = c.can('sales.price') ? (b.unitPrice ?? null) : null;
    const o = await c.db.one<{ id: number }>(
      `INSERT INTO sales_orders (company_id, code, customer_id, seller_id, status_id, currency, notes, created_by, completed_at, is_quick)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), true) RETURNING id`,
      [c.companyId, code, b.customerId ?? null, b.sellerId ?? null, status, company.currency, b.notes ?? null, c.userId]);
    for (const u of units) {
      await c.db.query('INSERT INTO sale_items (company_id, order_id, unit_id, unit_price) VALUES ($1,$2,$3,$4)', [c.companyId, o.id, u.id, price ?? u.list_price ?? null]);
      await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1', [u.id, sold]);
      await c.audit('unit.sold', 'unit', u.id, { orderId: o.id, orderCode: code, quick: true });
    }
    await c.audit('order.quick_sale', 'order', o.id, { code, items: units.length });
    await notifyEvent(c.db, c.companyId, 'order_completed', { id: o.id, code, items: units.length }, { actorUserId: c.userId, orderId: o.id });
    return { id: o.id, code, count: units.length };
  }));

  // ---------- Cerrar la venta / cancelar ----------
  app.post('/api/orders/:id/complete', route('sales.complete', async (c) => {
    const { id } = c.params(zIdParam);
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const items = await c.db.rows<{ unit_id: number }>('SELECT unit_id FROM sale_items WHERE order_id = $1 AND released_at IS NULL ORDER BY unit_id', [id]);
    if (!items.length) throw conflict('order_empty');
    const sold = await sysItemId(c.db, 'unit_status', 'sold');
    const reserved = await sysItemId(c.db, 'unit_status', 'reserved');
    const done = await c.db.rows<{ id: number }>(
      `UPDATE units SET status_id = $2 WHERE id = ANY($1::bigint[]) AND status_id = $3 RETURNING id`, [items.map((i) => i.unit_id), sold, reserved]);
    if (done.length !== items.length) throw conflict('unit_not_reserved');
    await c.db.query('UPDATE sales_orders SET status_id = $2, completed_at = now(), reserved_until = NULL WHERE id = $1', [id, await sysItemId(c.db, 'order_status', 'completed')]);
    for (const i of items) await c.audit('unit.sold', 'unit', i.unit_id, { orderId: id, orderCode: o.code });
    await c.audit('order.completed', 'order', id, { code: o.code, items: items.length });
    const cust = o.customer_id ? await c.db.opt<{ name: string }>('SELECT name FROM customers WHERE id = $1', [o.customer_id]) : null;
    await notifyEvent(c.db, c.companyId, 'order_completed', { id, code: o.code, items: items.length, customer: cust?.name }, { actorUserId: c.userId, alsoUserIds: [o.created_by], orderId: id });
    return orderDetail(c, id);
  }));

  app.post('/api/orders/:id/cancel', route('sales.cancel', async (c) => {
    const { id } = c.params(zIdParam);
    const o = await loadOrder(c, id, true);
    if (o.status_key !== 'open') throw conflict('order_not_open');
    const items = await c.db.rows<{ id: number }>('SELECT id FROM sale_items WHERE order_id = $1 AND released_at IS NULL', [id]);
    await releaseItems(c, items.map((i) => i.id), 'order_cancelled');
    await c.db.query('UPDATE sales_orders SET status_id = $2, cancelled_at = now(), reserved_until = NULL WHERE id = $1', [id, await sysItemId(c.db, 'order_status', 'cancelled')]);
    await c.audit('order.cancelled', 'order', id, { code: o.code });
    await notifyEvent(c.db, c.companyId, 'order_cancelled', { id, code: o.code }, { actorUserId: c.userId, alsoUserIds: [o.created_by], orderId: id });
    return orderDetail(c, id);
  }));
}
