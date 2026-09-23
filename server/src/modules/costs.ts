import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam } from '../http.js';
import { lockRows } from '../services/common.js';
import { allocPlanSchema } from '../services/allocation.js';
import { applyLotCosts, clearLotCosts, computeLotCosts, costStatus, maybeAutoApply, parsePlan, type CostExtra } from '../services/costs.js';
import { applyPriceRules, autoPriceEnabled } from '../services/prices.js';

const extraSchema = z.object({
  label: z.string().trim().min(1).max(80),
  amount: z.number().min(0).max(1e10),
  distribute: z.boolean().default(true),
});

const saveBody = z.object({
  totalCost: z.number().min(0).max(1e10).nullable().optional(),
  extras: z.array(extraSchema).max(50).optional(),
  plan: allocPlanSchema.optional(),
  /** Además de guardar, repartir ahora el costo entre los equipos. */
  apply: z.boolean().default(false),
});

async function assertLot(c: Ctx, lotId: number, forUpdate = false) {
  if (forUpdate) await lockRows(c.db, 'lots', [lotId]);
  const lot = await c.db.opt<{ id: number; cost_plan: unknown; cost_applied_at: string | null; total_cost: number | null }>(
    'SELECT id, cost_plan, cost_applied_at, total_cost FROM lots WHERE id = $1', [lotId]);
  if (!lot) throw notFound('lot_not_found');
  return lot;
}

/** Lo que muestra la pantalla de costos: montos, plan, resultado del reparto por línea y estado. */
export async function costOverview(c: Ctx, lotId: number, o: { totalCost?: number | null; extras?: CostExtra[]; plan?: z.infer<typeof allocPlanSchema> } = {}) {
  const lot = await assertLot(c, lotId);
  const plan = o.plan ?? parsePlan(lot.cost_plan);
  const comp = await computeLotCosts(c.db, lotId, plan, { totalCost: o.totalCost, extras: o.extras });
  const stats = await c.db.one<{ units: number; withCost: number; manual: number; sum: number | null }>(
    `SELECT count(*)::int AS units, count(cost)::int AS "withCost", (count(*) FILTER (WHERE cost_source = 'manual'))::int AS manual, sum(cost)::float AS sum FROM units WHERE lot_id = $1`, [lotId]);
  const extrasTotal = comp.input.extras.reduce((a, e) => a + e.amount, 0);
  return {
    currency: comp.input.currency,
    merchandise: comp.input.merchandise,
    extras: comp.input.extras,
    extrasTotal,
    /** Total del lote (mercancía + todos los costos adicionales, se repartan o no). */
    landed: (comp.input.merchandise ?? 0) + extrasTotal,
    pool: comp.input.pool,
    plan,
    status: costStatus(lot.cost_applied_at, comp),
    appliedAt: lot.cost_applied_at,
    rows: comp.input.targets.map((t) => ({
      key: t.key, kind: t.kind, lineId: t.lineId ?? null, lineNo: t.lineNo, typeId: t.typeId, specs: t.specs,
      expected: t.expected, counted: t.counted, units: t.units, frozenQty: t.frozenQty, qty: t.qty,
      perUnit: comp.result.perUnit.get(t.key) ?? 0, total: comp.result.total.get(t.key) ?? 0, ruleId: comp.result.ruleOf.get(t.key) ?? null,
      currentUnitCost: t.currentUnitCost,
    })),
    summary: comp.result.summary,
    warnings: comp.result.warnings,
    stats,
  };
}

export async function costRoutes(app: FastifyInstance) {
  app.get('/api/lots/:id/costs', route('costs.view', async (c) => costOverview(c, c.params(zIdParam).id)));

  /** Vista previa: calcula con lo que se está editando, sin guardar nada. */
  app.post('/api/lots/:id/costs/preview', route('costs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(saveBody);
    return costOverview(c, id, { totalCost: b.totalCost, extras: b.extras, plan: b.plan });
  }));

  /** Guarda el costo de la mercancía, los costos adicionales y/o el plan; con `apply` reparte el costo entre los equipos. */
  app.put('/api/lots/:id/costs', route('costs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(saveBody);
    const lot = await assertLot(c, id, true);
    if (b.totalCost !== undefined) await c.db.query('UPDATE lots SET total_cost = $2 WHERE id = $1', [id, b.totalCost]);
    if (b.extras) {
      await c.db.query('DELETE FROM lot_costs WHERE lot_id = $1', [id]);
      let i = 0;
      for (const e of b.extras) await c.db.query('INSERT INTO lot_costs (company_id, lot_id, label, amount, distribute, sort_order) VALUES ($1,$2,$3,$4,$5,$6)', [c.companyId, id, e.label, e.amount, e.distribute, i++]);
    }
    const plan = b.plan ?? parsePlan(lot.cost_plan);
    if (b.plan) await c.db.query('UPDATE lots SET cost_plan = $2 WHERE id = $1', [id, JSON.stringify(plan)]);
    await c.audit('lot.costs_saved', 'lot', id, { totalCost: b.totalCost, extras: b.extras?.length, rules: b.plan?.rules.length });
    if (b.apply) await applyLotCosts(c.db, c.audit, c.userId, id, plan);
    else if (lot.cost_applied_at) await maybeAutoApply(c, id);
    return costOverview(c, id);
  }));

  /** Quita los costos repartidos (los costos fijados a mano en equipos se conservan). */
  app.post('/api/lots/:id/costs/clear', route('costs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    await assertLot(c, id, true);
    await clearLotCosts(c.db, c.audit, id);
    return costOverview(c, id);
  }));

  // ---------- Costo individual de equipos ----------
  const bulkBody = z.object({
    unitIds: z.array(zId).min(1).max(5000),
    /** set = costo exacto · pct = subir/bajar un porcentaje · add = sumar/restar un monto · plan = volver al reparto del lote */
    mode: z.enum(['set', 'pct', 'add', 'plan']),
    value: z.number().min(-1e10).max(1e10).optional(),
  });

  async function changeCosts(c: Ctx, b: z.infer<typeof bulkBody>) {
    if (b.mode !== 'plan' && b.value === undefined) throw badRequest('invalid_value');
    if (b.mode === 'set' && b.value! < 0) throw badRequest('invalid_value');
    const ids = [...new Set(b.unitIds)].sort((x, y) => x - y);
    await lockRows(c.db, 'units', ids);
    const units = await c.db.rows<{ id: number; lot_id: number; code: string; status_key: string; cost: number | null }>(
      `SELECT u.id, u.lot_id, u.code, st.system_key AS status_key, u.cost FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.id = ANY($1::bigint[])`, [ids]);
    if (units.length !== ids.length) throw notFound('unit_not_found');
    const sold = units.find((u) => u.status_key === 'sold');
    if (sold) throw conflict('unit_sold', { code: sold.code });
    for (const u of units) {
      if (b.mode === 'plan') {
        await c.db.query(`UPDATE units u SET cost = ll.unit_cost, cost_source = CASE WHEN ll.unit_cost IS NULL THEN NULL ELSE 'plan' END
                            FROM (SELECT u2.id, l.unit_cost FROM units u2 LEFT JOIN lot_lines l ON l.id = u2.lot_line_id WHERE u2.id = $1) ll WHERE u.id = ll.id`, [u.id]);
      } else {
        const cost = b.mode === 'set' ? b.value! : b.mode === 'pct' ? (u.cost ?? 0) * (1 + b.value! / 100) : (u.cost ?? 0) + b.value!;
        await c.db.query(`UPDATE units SET cost = $2, cost_source = 'manual' WHERE id = $1`, [u.id, Math.max(0, Math.round(cost * 10000) / 10000)]);
      }
      await c.audit('unit.cost_changed', 'unit', u.id, { from: u.cost, mode: b.mode, value: b.value ?? null });
    }
    // El resto del lote se reparte de nuevo con lo que quedó fijado a mano, y los precios basados en costo se actualizan.
    for (const lotId of new Set(units.map((u) => u.lot_id))) {
      await maybeAutoApply(c, lotId);
      if (await autoPriceEnabled(c.db)) await applyPriceRules(c.db, { lotId, scope: 'unsold', unitIds: ids });
    }
    return { ok: true, count: units.length };
  }

  app.post('/api/units/costs', route('costs.manage', async (c) => changeCosts(c, c.body(bulkBody))));
  app.put('/api/units/:id/cost', route('costs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ cost: z.number().min(0).max(1e10).nullable() }));
    return changeCosts(c, b.cost === null ? { unitIds: [id], mode: 'plan' } : { unitIds: [id], mode: 'set', value: b.cost });
  }));

  // ---------- Planes guardados ----------
  app.get('/api/cost-templates', route('costs.view', async (c) => ({
    items: await c.db.rows('SELECT id, name, plan, created_at AS "createdAt" FROM cost_templates ORDER BY lower(name)'),
  })));
  app.post('/api/cost-templates', route('costs.manage', async (c) => {
    const b = c.body(z.object({ name: z.string().trim().min(1).max(80), plan: allocPlanSchema }));
    if (await c.db.opt('SELECT 1 FROM cost_templates WHERE lower(name) = lower($1)', [b.name])) throw conflict('name_taken');
    const r = await c.db.one<{ id: number }>('INSERT INTO cost_templates (company_id, name, plan, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [c.companyId, b.name, JSON.stringify(b.plan), c.userId]);
    return { id: r.id };
  }));
  app.delete('/api/cost-templates/:id', route('costs.manage', async (c) => {
    const r = await c.db.query('DELETE FROM cost_templates WHERE id = $1', [c.params(zIdParam).id]);
    if (!r.rowCount) throw notFound('not_found');
    return { ok: true };
  }));
}
