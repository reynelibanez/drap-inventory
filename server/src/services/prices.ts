import { z } from 'zod';
import type { Db } from '../db.js';
import { ruleMatchSchema, ruleMatches, type AllocTarget } from './allocation.js';

/** Precio de lista de los equipos: reglas ordenadas (la primera que corresponde gana) + precio fijado a mano por equipo. */

export const PRICE_METHODS = ['fixed', 'markup_pct', 'margin_pct', 'add_amount'] as const;
export type PriceMethod = (typeof PRICE_METHODS)[number];
export const ROUNDINGS = ['none', 'unit', 'five', 'ten', 'x99'] as const;
export type Rounding = (typeof ROUNDINGS)[number];

export const priceMatchSchema = ruleMatchSchema.omit({ lineIds: true, unlinked: true }).extend({
  lotIds: z.array(z.number().int().positive()).max(500).optional(),
  /** Solo equipos cuyo costo está en este rango. */
  costMin: z.number().min(0).nullable().optional(),
  costMax: z.number().min(0).nullable().optional(),
}).strict();
export type PriceMatch = z.infer<typeof priceMatchSchema>;

export const priceRuleSchema = z.object({
  name: z.string().trim().max(80).default(''),
  enabled: z.boolean().default(true),
  match: priceMatchSchema.default({}),
  method: z.enum(PRICE_METHODS),
  value: z.number().min(0).max(1e9),
  rounding: z.enum(ROUNDINGS).default('none'),
  minPrice: z.number().min(0).max(1e9).nullish(),
}).strict();
export type PriceRuleInput = z.infer<typeof priceRuleSchema>;
export interface PriceRule extends PriceRuleInput { id: number }

export interface PriceUnit {
  id: number; typeId: number; specs: Record<string, unknown>; cosmeticGradeId: number | null; functionalGradeId: number | null;
  lotId: number; cost: number | null;
}

/** Redondeo comercial del precio calculado. */
export function roundPrice(v: number, how: Rounding): number {
  let r: number;
  switch (how) {
    case 'unit': r = Math.round(v); break;
    case 'five': r = Math.round(v / 5) * 5; break;
    case 'ten': r = Math.round(v / 10) * 10; break;
    case 'x99': r = Math.round(v + 0.01) - 0.01; break;   // el más cercano que termina en .99
    default: r = v;
  }
  return Math.max(0, Math.round(r * 100) / 100);
}

/** Precio que dan las reglas para un equipo (o null si ninguna corresponde). */
export function priceFor(rules: PriceRule[], u: PriceUnit): { price: number; ruleId: number } | null {
  const target: AllocTarget = { key: String(u.id), qty: 1, typeId: u.typeId, specs: u.specs, cosmeticGradeId: u.cosmeticGradeId, functionalGradeId: u.functionalGradeId };
  for (const r of rules) {
    if (!r.enabled) continue;
    const m = r.match;
    if (!ruleMatches(m, target)) continue;
    if (m.lotIds?.length && !m.lotIds.includes(u.lotId)) continue;
    if ((m.costMin !== null && m.costMin !== undefined) || (m.costMax !== null && m.costMax !== undefined)) {
      if (u.cost === null) continue;
      if (m.costMin !== null && m.costMin !== undefined && u.cost < m.costMin) continue;
      if (m.costMax !== null && m.costMax !== undefined && u.cost > m.costMax) continue;
    }
    let base: number;
    switch (r.method) {
      case 'fixed': base = r.value; break;
      case 'add_amount': if (u.cost === null) continue; base = u.cost + r.value; break;
      case 'markup_pct': if (u.cost === null) continue; base = u.cost * (1 + r.value / 100); break;
      case 'margin_pct': if (u.cost === null || r.value >= 100) continue; base = u.cost / (1 - r.value / 100); break;
    }
    let price = roundPrice(base, r.rounding);
    if (r.minPrice !== null && r.minPrice !== undefined && price < r.minPrice) price = r.minPrice;
    return { price, ruleId: r.id };
  }
  return null;
}

export async function loadPriceRules(db: Db): Promise<PriceRule[]> {
  const rows = await db.rows<any>(
    'SELECT id, name, enabled, match, method, value, rounding, min_price FROM price_rules ORDER BY sort_order, id');
  return rows.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, match: r.match ?? {}, method: r.method, value: r.value, rounding: r.rounding, minPrice: r.min_price }));
}

export async function autoPriceEnabled(db: Db): Promise<boolean> {
  const r = await db.opt<{ v: boolean | null }>(`SELECT (settings->>'autoPrice')::boolean AS v FROM companies LIMIT 1`);
  return r?.v !== false;   // por defecto, activado
}

export type PriceScope = 'available' | 'unsold';

export interface PriceChange { unitId: number; code: string; from: number | null; to: number | null; source: string | null; ruleId: number | null }

/**
 * Calcula (y, si `dryRun` es falso, guarda) los precios de lista según las reglas.
 *  - `available`: solo equipos disponibles · `unsold`: todo lo que no está vendido ni reservado.
 *  - Los precios fijados a mano se respetan (salvo `overwriteManual`).
 *  - Un equipo con precio de regla al que ya no le corresponde ninguna regla queda sin precio.
 */
export async function applyPriceRules(db: Db, opts: { scope?: PriceScope; lotId?: number | null; unitIds?: number[]; overwriteManual?: boolean; dryRun?: boolean; rules?: PriceRule[]; sample?: number } = {}) {
  const rules = opts.rules ?? await loadPriceRules(db);
  const where: string[] = [opts.scope === 'available' ? `st.system_key = 'available'` : `st.system_key NOT IN ('sold', 'reserved')`];
  const p: unknown[] = [];
  if (opts.lotId) { p.push(opts.lotId); where.push(`u.lot_id = $${p.length}`); }
  if (opts.unitIds) { p.push(opts.unitIds); where.push(`u.id = ANY($${p.length}::bigint[])`); }
  const units = await db.rows<any>(
    `SELECT u.id, u.code, u.equipment_type_id AS "typeId", u.specs, u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId",
            u.lot_id AS "lotId", u.cost, u.list_price AS "listPrice", u.price_source AS "priceSource"
       FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE ${where.join(' AND ')} ORDER BY u.id`, p);
  const changes: PriceChange[] = [];
  let skippedManual = 0;
  const batch: { id: number; price: number | null; source: string | null }[] = [];
  for (const u of units) {
    if (u.priceSource === 'manual' && !opts.overwriteManual) { skippedManual++; continue; }
    const hit = priceFor(rules, u);
    const to = hit?.price ?? null;
    const source = hit ? 'rule' : null;
    if (to === u.listPrice && source === u.priceSource) continue;
    changes.push({ unitId: u.id, code: u.code, from: u.listPrice, to, source, ruleId: hit?.ruleId ?? null });
    batch.push({ id: u.id, price: to, source });
  }
  if (!opts.dryRun && batch.length) {
    for (let i = 0; i < batch.length; i += 500) {
      const part = batch.slice(i, i + 500);
      await db.query(
        `UPDATE units u SET list_price = x.price, price_source = x.source
           FROM unnest($1::bigint[], $2::numeric[], $3::text[]) AS x(id, price, source) WHERE u.id = x.id`,
        [part.map((b) => b.id), part.map((b) => b.price), part.map((b) => b.source)]);
    }
  }
  return { considered: units.length, changed: changes.length, skippedManual, changes: changes.slice(0, opts.sample ?? 0) };
}
