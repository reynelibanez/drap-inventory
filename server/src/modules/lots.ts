import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam, zPage } from '../http.js';
import { getSettings, nextLotCode } from '../settings.js';
import { likeEscape, lockRows, sysItemId, sysKeys } from '../services/common.js';
import { notifyEvent } from '../services/notifications.js';
import { normalizeSpecs, type Specs } from '../services/specs.js';
import { maybeAutoApply } from '../services/costs.js';
import { applyPriceRules, autoPriceEnabled } from '../services/prices.js';
import { insertUnit } from './units.js';

const lineInput = z.object({
  equipmentTypeId: zId,
  specs: z.record(z.string(), z.unknown()).default({}),
  expectedQty: z.number().int().min(0).max(1_000_000).default(0),
  notes: z.string().trim().max(500).nullish(),
});

/** Transiciones permitidas del lote (por clave de sistema del estado). */
const TRANSITIONS: Record<string, Record<string, string>> = {
  open:     { start_count: 'counting', start_testing: 'testing' },
  counting: { finish_count: 'counted', start_testing: 'testing' },
  counted:  { start_testing: 'testing', reopen_count: 'counting' },
  testing:  { close: 'closed', reopen_count: 'counting' },
  closed:   { reopen: 'testing' },
};

async function getLot(c: Ctx, id: number, forUpdate = false) {
  if (forUpdate) await lockRows(c.db, 'lots', [id]);
  const lot = await c.db.opt<any>(
    `SELECT l.*, ci.system_key AS status_key FROM lots l JOIN catalog_items ci ON ci.id = l.status_id WHERE l.id = $1`, [id]);
  if (!lot) throw notFound('lot_not_found');
  return lot;
}

async function lotDetail(c: Ctx, id: number) {
  const lot = await c.db.opt<any>(
    `SELECT l.id, l.code, l.status_id AS "statusId", ci.system_key AS "statusKey", l.supplier_id AS "supplierId", s.name AS "supplierName",
            l.purchase_date AS "purchaseDate", l.reference, l.currency, l.total_cost AS "totalCost", l.notes, l.requires_testing AS "requiresTesting",
            l.counted_at AS "countedAt", l.closed_at AS "closedAt", l.created_at AS "createdAt"
       FROM lots l JOIN catalog_items ci ON ci.id = l.status_id LEFT JOIN suppliers s ON s.id = l.supplier_id WHERE l.id = $1`, [id]);
  if (!lot) throw notFound('lot_not_found');
  const lines = await c.db.rows<any>(
    `SELECT ll.id, ll.line_no AS "lineNo", ll.equipment_type_id AS "equipmentTypeId", ll.specs, ll.expected_qty AS "expectedQty",
            ll.counted_qty AS "countedQty", ll.is_unexpected AS "isUnexpected", ll.notes, ll.counted_at AS "countedAt", ll.unit_cost AS "unitCost",
            (SELECT count(*) FROM units u WHERE u.lot_line_id = ll.id)::int AS tested,
            (SELECT count(*) FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_line_id = ll.id AND st.system_key = 'testing')::int AS "inTesting"
       FROM lot_lines ll WHERE ll.lot_id = $1 ORDER BY ll.line_no`, [id]);
  const byStatus = await c.db.rows<{ statusId: number; n: number }>(
    'SELECT status_id AS "statusId", count(*)::int AS n FROM units WHERE lot_id = $1 GROUP BY status_id', [id]);
  // Equipos agregados al lote que no coinciden con ninguna línea: se agrupan por tipo y características.
  const offLines = await c.db.rows<{ equipmentTypeId: number; specs: Record<string, unknown>; tested: number; inTesting: number }>(
    `SELECT u.equipment_type_id AS "equipmentTypeId", u.specs, count(*)::int AS tested,
            (count(*) FILTER (WHERE st.system_key = 'testing'))::int AS "inTesting"
       FROM units u JOIN catalog_items st ON st.id = u.status_id
      WHERE u.lot_id = $1 AND u.lot_line_id IS NULL
      GROUP BY u.equipment_type_id, u.specs
      ORDER BY count(*) DESC, u.equipment_type_id`, [id]);
  const unlinked = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE lot_id = $1 AND lot_line_id IS NULL', [id])).n;

  let expected = 0, counted = 0, missing = 0, surplus = 0, uncounted = 0;
  for (const l of lines) {
    expected += l.expectedQty;
    if (l.countedQty === null) { uncounted++; continue; }
    counted += l.countedQty;
    const diff = l.countedQty - l.expectedQty;
    if (diff < 0) missing += -diff; else surplus += diff;
  }
  // Los costos solo los ven quienes tienen ese permiso.
  const canCost = c.can('costs.view');
  let costs: Record<string, unknown> = {};
  if (canCost) {
    const x = await c.db.one<{ extras: number; applied: string | null }>(
      `SELECT COALESCE((SELECT sum(amount) FROM lot_costs WHERE lot_id = $1), 0)::float AS extras, (SELECT cost_applied_at FROM lots WHERE id = $1) AS applied`, [id]);
    costs = { extrasTotal: x.extras, landedCost: (lot.totalCost ?? 0) + x.extras, costAppliedAt: x.applied };
  } else {
    lot.totalCost = null;
    for (const l of lines) l.unitCost = null;
  }
  return {
    ...lot, ...costs, canSeeCosts: canCost,
    /** Se puede eliminar cualquier lote que no esté cerrado (si tiene equipos, se eliminan con él; ver DELETE /api/lots/:id). */
    deletable: lot.statusKey !== 'closed',
    lines: lines.map((l) => ({ ...l, difference: l.countedQty === null ? null : l.countedQty - l.expectedQty })),
    offLines,
    summary: { expected, counted, missing, surplus, uncountedLines: uncounted, units: byStatus.reduce((a, b) => a + b.n, 0), unlinkedUnits: unlinked, unitsByStatus: byStatus },
  };
}

export async function lotRoutes(app: FastifyInstance) {
  // ---------- Listado ----------
  app.get('/api/lots', route('lots.view', async (c) => {
    const q = c.query(zPage.extend({ statusId: zId.optional(), supplierId: zId.optional(), openOnly: z.enum(['1']).optional() }));
    const p: unknown[] = [];
    const where: string[] = [];
    if (q.q) { p.push(`%${likeEscape(q.q)}%`); where.push(`(l.code ILIKE $${p.length} OR l.reference ILIKE $${p.length} OR s.name ILIKE $${p.length})`); }
    if (q.statusId) { p.push(q.statusId); where.push(`l.status_id = $${p.length}`); }
    if (q.supplierId) { p.push(q.supplierId); where.push(`l.supplier_id = $${p.length}`); }
    if (q.openOnly) where.push(`ci.system_key <> 'closed'`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = `FROM lots l JOIN catalog_items ci ON ci.id = l.status_id LEFT JOIN suppliers s ON s.id = l.supplier_id ${w}`;
    const total = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n ${from}`, p)).n;
    const items = await c.db.rows(
      `SELECT l.id, l.code, l.status_id AS "statusId", ci.system_key AS "statusKey", l.supplier_id AS "supplierId", s.name AS "supplierName",
              l.purchase_date AS "purchaseDate", l.reference, l.created_at AS "createdAt", l.requires_testing AS "requiresTesting",
              (SELECT COALESCE(sum(expected_qty), 0) FROM lot_lines WHERE lot_id = l.id)::int AS expected,
              (SELECT COALESCE(sum(counted_qty), 0) FROM lot_lines WHERE lot_id = l.id)::int AS counted,
              (SELECT count(*) FROM lot_lines WHERE lot_id = l.id)::int AS lines,
              (SELECT count(*) FROM lot_lines WHERE lot_id = l.id AND counted_qty IS NULL)::int AS "uncountedLines",
              (ci.system_key <> 'closed') AS deletable,
              (SELECT count(*) FROM units WHERE lot_id = l.id)::int AS units,
              (SELECT count(*) FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_id = l.id AND st.system_key = 'testing')::int AS "inTesting"
         ${from} ORDER BY l.created_at DESC, l.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { items, total };
  }));

  app.get('/api/lots/:id', route('lots.view', async (c) => lotDetail(c, c.params(zIdParam).id)));

  // ---------- Alta ----------
  app.post('/api/lots', route('lots.create', async (c) => {
    const b = c.body(z.object({
      supplierId: zId.nullish(),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      reference: z.string().trim().max(100).nullish(),
      currency: z.string().length(3).toUpperCase().optional(),
      totalCost: z.number().min(0).nullish(),
      notes: z.string().trim().max(1000).nullish(),
      // Si no requiere testeo individual, sus equipos pueden pasar directo a disponibles (venta de PC suelta o del lote completo).
      requiresTesting: z.boolean().default(true),
      lines: z.array(lineInput).max(200).default([]),
    }));
    if (b.supplierId && !(await c.db.opt('SELECT 1 FROM suppliers WHERE id = $1 AND is_active', [b.supplierId]))) throw badRequest('invalid_supplier');
    const settings = await getSettings(c.db, c.companyId);
    const date = b.purchaseDate ? new Date(b.purchaseDate + 'T00:00:00Z') : new Date();
    const code = await nextLotCode(c.db, settings, date);
    const status = await sysItemId(c.db, 'lot_status', 'open');
    const company = await c.db.one<{ currency: string }>('SELECT currency FROM companies WHERE id = $1', [c.companyId]);
    const lot = await c.db.one<{ id: number }>(
      `INSERT INTO lots (company_id, code, supplier_id, status_id, purchase_date, reference, currency, total_cost, notes, requires_testing, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [c.companyId, code, b.supplierId ?? null, status, b.purchaseDate ?? date.toISOString().slice(0, 10), b.reference ?? null,
        b.currency ?? company.currency, c.can('costs.manage') ? b.totalCost ?? null : null, b.notes ?? null, b.requiresTesting, c.userId]);
    let n = 1;
    const lineIds: { id: number; lineNo: number }[] = [];
    for (const l of b.lines) {
      const specs = await normalizeSpecs(c.db, l.equipmentTypeId, l.specs, 'lot', { onlyLotLine: true });
      const r = await c.db.one<{ id: number }>(
        `INSERT INTO lot_lines (company_id, lot_id, line_no, equipment_type_id, specs, expected_qty, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [c.companyId, lot.id, n, l.equipmentTypeId, JSON.stringify(specs), l.expectedQty, l.notes ?? null]);
      lineIds.push({ id: r.id, lineNo: n++ });
    }
    await c.audit('lot.created', 'lot', lot.id, { code, lines: b.lines.length });
    // Los ids de las líneas se devuelven para que la app pueda enlazar lo que registró sin conexión.
    return { id: lot.id, code, lines: lineIds };
  }));

  app.patch('/api/lots/:id', route('lots.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      supplierId: zId.nullable().optional(),
      purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      reference: z.string().trim().max(100).nullable().optional(),
      totalCost: z.number().min(0).nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
      requiresTesting: z.boolean().optional(),
    }));
    if (b.totalCost !== undefined) c.need('costs.manage');
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    if (b.supplierId && !(await c.db.opt('SELECT 1 FROM suppliers WHERE id = $1', [b.supplierId]))) throw badRequest('invalid_supplier');
    await c.db.query(
      `UPDATE lots SET supplier_id = CASE WHEN $2::boolean THEN $3 ELSE supplier_id END,
                       purchase_date = COALESCE($4::date, purchase_date),
                       reference = CASE WHEN $5::boolean THEN $6 ELSE reference END,
                       total_cost = CASE WHEN $7::boolean THEN $8 ELSE total_cost END,
                       notes = CASE WHEN $9::boolean THEN $10 ELSE notes END,
                       requires_testing = CASE WHEN $11::boolean THEN $12 ELSE requires_testing END
        WHERE id = $1`,
      [id, b.supplierId !== undefined, b.supplierId ?? null, b.purchaseDate ?? null, b.reference !== undefined, b.reference ?? null,
        b.totalCost !== undefined, b.totalCost ?? null, b.notes !== undefined, b.notes ?? null,
        b.requiresTesting !== undefined, b.requiresTesting ?? null]);
    await c.audit('lot.updated', 'lot', id);
    if (b.totalCost !== undefined) await maybeAutoApply(c, id);
    return { ok: true };
  }));

  // Se puede eliminar cualquier lote que no esté cerrado, aunque ya tenga equipos: se eliminan junto con el lote
  // (y sus reservas, si las tenían) igual que al eliminar un equipo individual. Un equipo ya VENDIDO nunca se toca:
  // si hay alguno, se rechaza todo el lote entero (no se elimina nada, ni siquiera los demás equipos).
  app.delete('/api/lots/:id', route('lots.delete', async (c) => {
    const { id } = c.params(zIdParam);
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    const units = await c.db.rows<{ id: number; code: string; status_key: string }>(
      `SELECT u.id, u.code, st.system_key AS status_key FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_id = $1 FOR UPDATE OF u`, [id]);
    const sold = units.filter((u) => u.status_key === 'sold');
    if (sold.length) throw conflict('lot_has_sold_units', { count: sold.length, codes: sold.map((u) => u.code).slice(0, 5).join(', ') });
    for (const u of units) {
      // El historial de reservas (activa o ya liberada) se elimina junto con el equipo; queda constancia en el historial general.
      await c.db.query('DELETE FROM sale_items WHERE unit_id = $1', [u.id]);
      await c.db.query('DELETE FROM units WHERE id = $1', [u.id]);
    }
    await c.db.query('DELETE FROM lots WHERE id = $1', [id]); // cascada: lot_lines y lot_costs se eliminan con él
    await c.audit('lot.deleted', 'lot', id, { code: lot.code, unitsDeleted: units.length });
    return { ok: true };
  }));

  // ---------- Líneas ----------
  app.post('/api/lots/:id/lines', route('lots.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(lineInput);
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'lot', { onlyLotLine: true });
    const next = (await c.db.one<{ n: number }>('SELECT COALESCE(max(line_no), 0) + 1 AS n FROM lot_lines WHERE lot_id = $1', [id])).n;
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO lot_lines (company_id, lot_id, line_no, equipment_type_id, specs, expected_qty, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [c.companyId, id, next, b.equipmentTypeId, JSON.stringify(specs), b.expectedQty, b.notes ?? null]);
    await c.audit('lot.line_added', 'lot', id, { lineId: r.id, expectedQty: b.expectedQty });
    await maybeAutoApply(c, id);
    return { id: r.id };
  }));

  app.put('/api/lots/:id/lines/:lineId', route('lots.edit', async (c) => {
    const { id, lineId } = c.params(z.object({ id: zId, lineId: zId }));
    const b = c.body(lineInput);
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    const line = await c.db.opt<any>('SELECT id, equipment_type_id FROM lot_lines WHERE id = $1 AND lot_id = $2 FOR UPDATE', [lineId, id]);
    if (!line) throw notFound('line_not_found');
    const units = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE lot_line_id = $1', [lineId])).n;
    if (units > 0 && line.equipment_type_id !== b.equipmentTypeId) throw conflict('line_has_units');
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'lot', { onlyLotLine: true });
    await c.db.query('UPDATE lot_lines SET equipment_type_id = $2, specs = $3, expected_qty = $4, notes = $5 WHERE id = $1',
      [lineId, b.equipmentTypeId, JSON.stringify(specs), b.expectedQty, b.notes ?? null]);
    await c.audit('lot.line_updated', 'lot', id, { lineId, expectedQty: b.expectedQty });
    await maybeAutoApply(c, id);
    return { ok: true };
  }));

  app.delete('/api/lots/:id/lines/:lineId', route('lots.edit', async (c) => {
    const { id, lineId } = c.params(z.object({ id: zId, lineId: zId }));
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    const units = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE lot_line_id = $1', [lineId])).n;
    if (units > 0) throw conflict('line_has_units');
    const r = await c.db.query('DELETE FROM lot_lines WHERE id = $1 AND lot_id = $2', [lineId, id]);
    if (!r.rowCount) throw notFound('line_not_found');
    await c.audit('lot.line_deleted', 'lot', id, { lineId });
    await maybeAutoApply(c, id);
    return { ok: true };
  }));

  // ---------- Conteo físico ----------
  /** Guarda las cantidades contadas (una o varias líneas a la vez). Pasa el lote a "en conteo" si estaba recién registrado. */
  app.put('/api/lots/:id/counts', route('lots.count', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ counts: z.array(z.object({ lineId: zId, countedQty: z.number().int().min(0).max(1_000_000).nullable() })).min(1).max(500) }));
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    for (const row of b.counts) {
      const line = await c.db.opt<{ id: number; counted_qty: number | null }>('SELECT id, counted_qty FROM lot_lines WHERE id = $1 AND lot_id = $2 FOR UPDATE', [row.lineId, id]);
      if (!line) throw notFound('line_not_found');
      if (row.countedQty !== null) {
        const tested = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE lot_line_id = $1', [row.lineId])).n;
        if (row.countedQty < tested) throw conflict('count_below_tested', { tested });
      }
      await c.db.query('UPDATE lot_lines SET counted_qty = $2, counted_by = $3, counted_at = now() WHERE id = $1', [row.lineId, row.countedQty, c.userId]);
      if (line.counted_qty !== row.countedQty) await c.audit('lot.counted', 'lot', id, { lineId: row.lineId, from: line.counted_qty, to: row.countedQty });
    }
    if (lot.status_key === 'open') {
      await c.db.query('UPDATE lots SET status_id = $2 WHERE id = $1', [id, await sysItemId(c.db, 'lot_status', 'counting')]);
    }
    await maybeAutoApply(c, id);
    return lotDetail(c, id);
  }));

  /** Aparece algo que no estaba en el lote: se agrega como línea "no esperada" con su cantidad contada. */
  app.post('/api/lots/:id/unexpected-lines', route('lots.count', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      equipmentTypeId: zId,
      specs: z.record(z.string(), z.unknown()).default({}),
      countedQty: z.number().int().min(1).max(1_000_000),
      notes: z.string().trim().max(500).nullish(),
    }));
    const lot = await getLot(c, id, true);
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'draft', { onlyLotLine: true });
    const next = (await c.db.one<{ n: number }>('SELECT COALESCE(max(line_no), 0) + 1 AS n FROM lot_lines WHERE lot_id = $1', [id])).n;
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO lot_lines (company_id, lot_id, line_no, equipment_type_id, specs, expected_qty, counted_qty, is_unexpected, counted_by, counted_at, notes)
       VALUES ($1,$2,$3,$4,$5,0,$6,true,$7,now(),$8) RETURNING id`,
      [c.companyId, id, next, b.equipmentTypeId, JSON.stringify(specs), b.countedQty, c.userId, b.notes ?? null]);
    if (lot.status_key === 'open') {
      await c.db.query('UPDATE lots SET status_id = $2 WHERE id = $1', [id, await sysItemId(c.db, 'lot_status', 'counting')]);
    }
    await c.audit('lot.unexpected_line', 'lot', id, { lineId: r.id, countedQty: b.countedQty });
    await maybeAutoApply(c, id);
    return { id: r.id };
  }));

  // ---------- Cambios de estado del lote ----------
  app.post('/api/lots/:id/transition', route('lots.close', async (c) => {
    const { id } = c.params(zIdParam);
    const { action, force } = c.body(z.object({ action: z.enum(['start_count', 'finish_count', 'start_testing', 'close', 'reopen_count', 'reopen']), force: z.boolean().default(false) }));
    const lot = await getLot(c, id, true);
    const target = TRANSITIONS[lot.status_key]?.[action];
    if (!target) throw conflict('invalid_transition', { from: lot.status_key, action });

    if (action === 'finish_count') {
      const pending = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM lot_lines WHERE lot_id = $1 AND counted_qty IS NULL', [id])).n;
      if (pending > 0 && !force) throw conflict('lines_not_counted', { pending });
    }
    if (action === 'close') {
      const open = (await c.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_id = $1 AND st.system_key = 'testing'`, [id])).n;
      if (open > 0) throw conflict('units_in_testing', { count: open });
    }
    const keys = await sysKeys(c.db, 'lot_status');
    const targetId = [...keys.entries()].find(([, k]) => k === target)![0];
    await c.db.query(
      `UPDATE lots SET status_id = $2,
              counted_at = CASE WHEN $3::text = 'counted' THEN now() ELSE counted_at END,
              closed_at = CASE WHEN $3::text = 'closed' THEN now() ELSE NULL END
        WHERE id = $1`, [id, targetId, target]);
    await c.audit('lot.status_changed', 'lot', id, { from: lot.status_key, to: target, action });
    if (action === 'finish_count') await notifyEvent(c.db, c.companyId, 'lot_counted', { id, code: lot.code }, { actorUserId: c.userId });
    if (action === 'start_testing') await notifyEvent(c.db, c.companyId, 'lot_testing', { id, code: lot.code }, { actorUserId: c.userId });
    return lotDetail(c, id);
  }));

  // ---------- Vender el lote completo (solo lotes que no requieren testeo individual) ----------
  // Genera de una vez los equipos que falten (disponibles, sin testeo ni grados) para cada línea, según lo contado
  // (o lo esperado si no se contó) menos lo que ya se haya registrado. Quedan listos para agregarse a un pedido o venta rápida.
  app.post('/api/lots/:id/sell-complete', route('units.test', async (c) => {
    const { id: lotId } = c.params(zIdParam);
    await lockRows(c.db, 'lots', [lotId]);
    const lot = await getLot(c, lotId);
    if (lot.requires_testing) throw conflict('lot_requires_testing');
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    if (lot.status_key === 'open' || lot.status_key === 'counting') throw conflict('lot_not_counted');

    const lines = await c.db.rows<{ id: number; equipment_type_id: number; specs: Specs; expected_qty: number; counted_qty: number | null }>(
      'SELECT id, equipment_type_id, specs, expected_qty, counted_qty FROM lot_lines WHERE lot_id = $1 ORDER BY line_no', [lotId]);
    const created: { id: number; code: string }[] = [];
    for (const line of lines) {
      const target = line.counted_qty ?? line.expected_qty;
      if (target <= 0) continue;
      const already = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM units WHERE lot_line_id = $1', [line.id])).n;
      for (let i = already; i < target; i++) {
        created.push(await insertUnit(c, {
          lotId, lotCode: lot.code, lineId: line.id, equipmentTypeId: line.equipment_type_id, specs: line.specs ?? {}, serial: null, available: true,
        }));
      }
    }
    if (!created.length) throw conflict('nothing_to_sell');
    await c.audit('lot.sold_complete', 'lot', lotId, { count: created.length });
    await maybeAutoApply(c, lotId);
    if (await autoPriceEnabled(c.db)) await applyPriceRules(c.db, { unitIds: created.map((u) => u.id), scope: 'unsold' });
    return { units: created };
  }));
}
