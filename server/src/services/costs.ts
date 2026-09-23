import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { AuditFn } from './common.js';
import { allocate, allocPlanSchema, DEFAULT_PLAN, type AllocPlan, type AllocResult, type AllocTarget } from './allocation.js';
import { autoPriceEnabled, applyPriceRules } from './prices.js';

/** Un destino del reparto de costos: una línea del lote, o un grupo de equipos que no pertenecen a ninguna línea. */
export interface CostTarget extends AllocTarget {
  kind: 'line' | 'group';
  lineNo: number | null;
  expected: number | null;
  counted: number | null;
  /** Equipos ya registrados de este destino. */
  units: number;
  /** Equipos que no se recalculan (vendidos o con costo fijado a mano) y lo que suman. */
  frozenQty: number;
  frozenCost: number;
  /** Costo por equipo que tiene hoy la línea (último reparto aplicado). */
  currentUnitCost: number | null;
}

export interface CostExtra { id?: number; label: string; amount: number; distribute: boolean }

export interface CostInput {
  lotId: number;
  currency: string;
  merchandise: number | null;
  extras: CostExtra[];
  /** Monto que se reparte: mercancía + costos adicionales marcados para repartir. */
  pool: number;
  targets: CostTarget[];
  frozen: number;
}

export function parsePlan(raw: unknown): AllocPlan {
  const r = allocPlanSchema.safeParse(raw ?? {});
  return r.success ? r.data : DEFAULT_PLAN;
}

const specsKey = (typeId: number, specs: unknown) => `g:${typeId}:${createHash('md5').update(JSON.stringify(specs ?? {})).digest('hex').slice(0, 12)}`;

/** Lee del lote todo lo que el reparto necesita. */
export async function loadCostInput(db: Db, lotId: number, plan: AllocPlan, overrides: { totalCost?: number | null; extras?: CostExtra[] } = {}): Promise<CostInput> {
  const lot = await db.one<{ currency: string; total_cost: number | null }>('SELECT currency, total_cost FROM lots WHERE id = $1', [lotId]);
  const extras = overrides.extras ?? await db.rows<CostExtra>(
    'SELECT id, label, amount, distribute FROM lot_costs WHERE lot_id = $1 ORDER BY sort_order, id', [lotId]);
  const merchandise = overrides.totalCost !== undefined ? overrides.totalCost : lot.total_cost;
  const pool = (merchandise ?? 0) + extras.filter((e) => e.distribute).reduce((a, e) => a + e.amount, 0);

  const lines = await db.rows<any>(
    `SELECT ll.id, ll.line_no, ll.equipment_type_id, ll.specs, ll.expected_qty, ll.counted_qty, ll.unit_cost,
            COALESCE(s.total, 0)::int AS units, COALESCE(s.fz_qty, 0)::int AS fz_qty, COALESCE(s.fz_cost, 0) AS fz_cost, s.avg_list
       FROM lot_lines ll
       LEFT JOIN LATERAL (
         SELECT count(*) AS total, count(*) FILTER (WHERE x.fz) AS fz_qty, sum(x.cost) FILTER (WHERE x.fz) AS fz_cost, avg(x.list_price) AS avg_list
           FROM (SELECT u.cost, u.list_price, (u.cost_source = 'manual' OR st.system_key = 'sold') AS fz
                   FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_line_id = ll.id) x) s ON true
      WHERE ll.lot_id = $1 ORDER BY ll.line_no`, [lotId]);
  const groups = await db.rows<any>(
    `SELECT u.equipment_type_id, u.specs, count(*)::int AS units,
            (count(*) FILTER (WHERE u.cost_source = 'manual' OR st.system_key = 'sold'))::int AS fz_qty,
            COALESCE(sum(u.cost) FILTER (WHERE u.cost_source = 'manual' OR st.system_key = 'sold'), 0) AS fz_cost,
            avg(u.list_price) AS avg_list,
            min(u.cost) FILTER (WHERE NOT (u.cost_source = 'manual' OR st.system_key = 'sold')) AS cur_min,
            max(u.cost) FILTER (WHERE NOT (u.cost_source = 'manual' OR st.system_key = 'sold')) AS cur_max,
            (count(*) FILTER (WHERE u.cost IS NULL AND NOT (u.cost_source = 'manual' OR st.system_key = 'sold')))::int AS no_cost
       FROM units u JOIN catalog_items st ON st.id = u.status_id
      WHERE u.lot_id = $1 AND u.lot_line_id IS NULL
      GROUP BY u.equipment_type_id, u.specs ORDER BY min(u.id)`, [lotId]);

  const targets: CostTarget[] = [];
  for (const l of lines) {
    const basis = plan.qtyBasis === 'expected' ? l.expected_qty : plan.qtyBasis === 'actual' ? l.units : (l.counted_qty ?? l.expected_qty);
    targets.push({
      key: `l:${l.id}`, kind: 'line', lineId: l.id, lineNo: l.line_no, typeId: l.equipment_type_id, specs: l.specs ?? {},
      expected: l.expected_qty, counted: l.counted_qty, units: l.units, frozenQty: l.fz_qty, frozenCost: l.fz_cost,
      qty: Math.max(0, Math.max(basis, l.units) - l.fz_qty), list: l.avg_list, currentUnitCost: l.unit_cost,
    });
  }
  for (const g of groups) {
    targets.push({
      key: specsKey(g.equipment_type_id, g.specs), kind: 'group', lineId: null, lineNo: null, typeId: g.equipment_type_id, specs: g.specs ?? {},
      expected: null, counted: null, units: g.units, frozenQty: g.fz_qty, frozenCost: g.fz_cost, qty: Math.max(0, g.units - g.fz_qty), list: g.avg_list,
      currentUnitCost: g.no_cost === 0 && g.cur_min !== null && g.cur_min === g.cur_max ? g.cur_min : null,
    });
  }
  return { lotId, currency: lot.currency, merchandise, extras, pool, targets, frozen: targets.reduce((a, t) => a + t.frozenCost, 0) };
}

export interface CostComputation { input: CostInput; plan: AllocPlan; result: AllocResult }

/** ¿Lo que hoy tienen las líneas y los equipos difiere de lo que daría el plan con los datos actuales? */
export function isStale(comp: CostComputation): boolean {
  return comp.input.targets.some((t) => {
    if (t.qty <= 0) return false;
    const want = comp.result.perUnit.get(t.key) ?? 0;
    return t.currentUnitCost === null || Math.abs(t.currentUnitCost - want) > 0.00005;
  });
}

export async function computeLotCosts(db: Db, lotId: number, plan: AllocPlan, overrides: { totalCost?: number | null; extras?: CostExtra[] } = {}): Promise<CostComputation> {
  const input = await loadCostInput(db, lotId, plan, overrides);
  const result = allocate({ pool: input.pool, targets: input.targets, rules: plan.rules, base: plan.base, frozen: input.frozen });
  return { input, plan, result };
}

/** Escribe el resultado: costo por equipo en cada línea y en sus equipos (menos vendidos y fijados a mano). */
export async function applyLotCosts(db: Db, audit: AuditFn, userId: number | null, lotId: number, plan: AllocPlan, opts: { auto?: boolean } = {}): Promise<CostComputation> {
  const comp = await computeLotCosts(db, lotId, plan);
  for (const t of comp.input.targets) {
    const unit = comp.result.perUnit.get(t.key) ?? 0;
    if (t.kind === 'line') {
      await db.query('UPDATE lot_lines SET unit_cost = $2 WHERE id = $1', [t.lineId, unit]);
      await db.query(
        `UPDATE units u SET cost = $2, cost_source = 'plan'
           FROM catalog_items st
          WHERE u.lot_line_id = $1 AND st.id = u.status_id AND st.system_key <> 'sold' AND u.cost_source IS DISTINCT FROM 'manual'`, [t.lineId, unit]);
    } else {
      await db.query(
        `UPDATE units u SET cost = $4, cost_source = 'plan'
           FROM catalog_items st
          WHERE u.lot_id = $1 AND u.lot_line_id IS NULL AND u.equipment_type_id = $2 AND u.specs = $3::jsonb
            AND st.id = u.status_id AND st.system_key <> 'sold' AND u.cost_source IS DISTINCT FROM 'manual'`, [lotId, t.typeId, JSON.stringify(t.specs), unit]);
    }
  }
  await db.query('UPDATE lots SET cost_plan = $2, cost_applied_at = now(), cost_applied_by = $3 WHERE id = $1', [lotId, JSON.stringify(plan), userId]);
  await audit(opts.auto ? 'lot.costs_recalculated' : 'lot.costs_applied', 'lot', lotId, { pool: comp.result.summary.pool, assigned: comp.result.summary.assigned, difference: comp.result.summary.difference });
  // Con los costos nuevos, las reglas de precio basadas en el costo dan otros precios.
  if (await autoPriceEnabled(db)) await applyPriceRules(db, { lotId, scope: 'unsold' });
  return comp;
}

export async function clearLotCosts(db: Db, audit: AuditFn, lotId: number): Promise<void> {
  await db.query('UPDATE lot_lines SET unit_cost = NULL WHERE lot_id = $1', [lotId]);
  await db.query(
    `UPDATE units u SET cost = NULL, cost_source = NULL FROM catalog_items st
      WHERE u.lot_id = $1 AND st.id = u.status_id AND st.system_key <> 'sold' AND u.cost_source = 'plan'`, [lotId]);
  await db.query('UPDATE lots SET cost_applied_at = NULL, cost_applied_by = NULL WHERE id = $1', [lotId]);
  await audit('lot.costs_cleared', 'lot', lotId);
}

/** Un equipo nuevo hereda el costo por equipo de su línea. */
export async function inheritUnitCost(db: Db, unitId: number): Promise<void> {
  await db.query(
    `UPDATE units u SET cost = ll.unit_cost, cost_source = 'plan' FROM lot_lines ll
      WHERE u.id = $1 AND ll.id = u.lot_line_id AND ll.unit_cost IS NOT NULL`, [unitId]);
}

/** Estado de los costos del lote: none = sin repartir · ok = al día · stale = cambió algo desde el último reparto. */
export function costStatus(appliedAt: string | null, comp: CostComputation): 'none' | 'ok' | 'stale' {
  if (!appliedAt) return 'none';
  return isStale(comp) ? 'stale' : 'ok';
}

interface AutoCtx { db: Db; audit: AuditFn; userId: number; req?: { log: { warn: (o: unknown, m?: string) => void } } }

/**
 * Si el lote tiene un reparto aplicado con "recalcular solo" activado, lo vuelve a calcular cuando cambian sus datos.
 * Nunca rompe la operación que lo llama: si algo falla, se deshace solo esto y queda el aviso de "desactualizado".
 */
export async function maybeAutoApply(c: AutoCtx, lotId: number): Promise<void> {
  const lot = await c.db.opt<{ cost_plan: unknown; cost_applied_at: string | null }>(
    'SELECT cost_plan, cost_applied_at FROM lots WHERE id = $1', [lotId]);
  if (!lot?.cost_applied_at) return;
  const plan = parsePlan(lot.cost_plan);
  if (!plan.auto) return;
  await c.db.query('SAVEPOINT auto_costs');
  try {
    if (isStale(await computeLotCosts(c.db, lotId, plan))) await applyLotCosts(c.db, c.audit, c.userId, lotId, plan, { auto: true });
    await c.db.query('RELEASE SAVEPOINT auto_costs');
  } catch (e) {
    await c.db.query('ROLLBACK TO SAVEPOINT auto_costs');
    c.req?.log.warn({ err: e, lotId }, 'auto cost recalculation failed');
  }
}
