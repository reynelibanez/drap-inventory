import { z } from 'zod';

/**
 * Motor de reparto de un monto entre grupos de equipos. Sirve para dos cosas:
 *  - repartir el COSTO de un lote entre sus líneas/equipos, y
 *  - repartir el PRECIO TOTAL de un pedido entre sus equipos.
 *
 * Es una función pura (sin base de datos): recibe un monto, los "destinos" (cada uno con su cantidad de equipos y sus
 * datos) y una lista ordenada de reglas, y devuelve cuánto le toca a cada equipo de cada destino.
 *
 * Cómo se decide (todo lo que el usuario puede combinar):
 *  1. Cada destino queda en la PRIMERA regla activa que le corresponde (por tipo, línea, propiedades, grado...).
 *  2. Reglas de monto fijo: `unit_amount` (X por equipo), `group_total` (X para todo el grupo, repartido parejo),
 *     `percent` (X % del monto total, repartido parejo).
 *  3. Lo que queda (monto − fijos − congelados) se reparte entre los destinos "con peso" en proporción a su peso:
 *     regla `weight` (peso por equipo), `by_list` (proporcional a su precio de lista), `by_cost` (a su costo) y los
 *     destinos sin regla, que usan la base (`equal` = todos pesan 1, `by_list`, `by_cost`).
 */

export const METHODS = ['unit_amount', 'group_total', 'percent', 'weight', 'by_list', 'by_cost'] as const;
export type Method = (typeof METHODS)[number];
export const BASES = ['equal', 'by_list', 'by_cost'] as const;
export type Base = (typeof BASES)[number];

const zIds = z.array(z.number().int().positive()).max(500);
export const ruleMatchSchema = z.object({
  typeIds: zIds.optional(),
  lineIds: zIds.optional(),
  cosmeticGradeIds: zIds.optional(),
  functionalGradeIds: zIds.optional(),
  /** Propiedades del equipo (clave → valor, o lista de valores posibles). */
  specs: z.record(z.string().max(60), z.unknown()).optional(),
  /** Solo equipos que no pertenecen a ninguna línea del lote. */
  unlinked: z.boolean().optional(),
}).strict();
export type RuleMatch = z.infer<typeof ruleMatchSchema>;

export const allocRuleSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().max(80).optional(),
  enabled: z.boolean().default(true),
  match: ruleMatchSchema.default({}),
  method: z.enum(METHODS),
  value: z.number().min(0).max(1e12),
}).strict();
export type AllocRule = z.infer<typeof allocRuleSchema>;

export const allocPlanSchema = z.object({
  /** Cómo pesan los destinos que ninguna regla reclamó. */
  base: z.enum(BASES).default('equal'),
  /** Qué cantidad de equipos se usa por línea: lo contado (o esperado), solo lo esperado, o solo los equipos ya registrados. */
  qtyBasis: z.enum(['auto', 'expected', 'actual']).default('auto'),
  /** Volver a repartir solo cuando cambian los datos del lote (conteos, costos, líneas...). */
  auto: z.boolean().default(true),
  rules: z.array(allocRuleSchema).max(100).default([]),
}).strict();
export type AllocPlan = z.infer<typeof allocPlanSchema>;
export const DEFAULT_PLAN: AllocPlan = allocPlanSchema.parse({});

export interface AllocTarget {
  key: string;
  /** Equipos que reciben parte del monto. */
  qty: number;
  typeId: number;
  specs: Record<string, unknown>;
  lineId?: number | null;
  cosmeticGradeId?: number | null;
  functionalGradeId?: number | null;
  /** Precio de lista por equipo (para `by_list`) y costo por equipo (para `by_cost`). */
  list?: number | null;
  cost?: number | null;
}

export type Warning =
  | { code: 'over_allocated'; amount: number }     // lo fijado supera el monto: no alcanza para los demás
  | { code: 'unallocated'; amount: number }        // sobra monto y no hay a quién dárselo
  | { code: 'rule_unused'; ruleId: string }        // una regla activa no le corresponde a ningún destino
  | { code: 'empty_group'; ruleId: string };      // la regla reclamó destinos sin equipos: su monto no se puede repartir

export interface AllocResult {
  perUnit: Map<string, number>;
  total: Map<string, number>;
  ruleOf: Map<string, string | null>;
  summary: {
    pool: number;
    /** Ya asignado a equipos que no se recalculan (vendidos o fijados a mano). */
    frozen: number;
    /** Asignado por reglas de monto fijo. */
    fixed: number;
    /** Lo que se reparte por peso. */
    remainder: number;
    /** Total asignado (congelado + fijo + peso). */
    assigned: number;
    /** monto − asignado: positivo = falta asignar, negativo = se asignó de más. */
    difference: number;
    weightedQty: number;
  };
  warnings: Warning[];
}

const norm = (v: unknown) => String(v).trim().toLowerCase();

/** ¿El valor de la propiedad coincide con lo pedido? Lo pedido puede ser un valor o una lista (basta uno). */
function specMatches(actual: unknown, wanted: unknown): boolean {
  const want = Array.isArray(wanted) ? wanted : [wanted];
  if (!want.length) return true;
  if (actual === undefined || actual === null || actual === '') return false;
  const have = Array.isArray(actual) ? actual : [actual];
  return want.some((w) => have.some((h) => norm(h) === norm(w)));
}

export function ruleMatches(m: RuleMatch, t: AllocTarget): boolean {
  if (m.typeIds?.length && !m.typeIds.includes(t.typeId)) return false;
  if (m.lineIds?.length && (t.lineId === null || t.lineId === undefined || !m.lineIds.includes(t.lineId))) return false;
  if (m.unlinked && t.lineId !== null && t.lineId !== undefined) return false;
  if (m.cosmeticGradeIds?.length && (!t.cosmeticGradeId || !m.cosmeticGradeIds.includes(t.cosmeticGradeId))) return false;
  if (m.functionalGradeIds?.length && (!t.functionalGradeId || !m.functionalGradeIds.includes(t.functionalGradeId))) return false;
  if (m.specs) for (const [k, v] of Object.entries(m.specs)) if (!specMatches(t.specs?.[k], v)) return false;
  return true;
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface AllocInput {
  pool: number;
  targets: AllocTarget[];
  rules: AllocRule[];
  base?: Base;
  /** Monto que ya tienen los equipos que no se recalculan (fuera de `targets`). */
  frozen?: number;
}

export function allocate(input: AllocInput): AllocResult {
  const { targets, base = 'equal' } = input;
  const pool = Math.max(0, input.pool);
  const frozen = input.frozen ?? 0;
  const rules = input.rules.filter((r) => r.enabled !== false);
  const warnings: Warning[] = [];
  const perUnit = new Map<string, number>();
  const ruleOf = new Map<string, string | null>();

  // 1) A cada destino, la primera regla que le corresponde.
  const claimed = new Map<string, AllocTarget[]>();
  for (const r of rules) claimed.set(r.id, []);
  const free: AllocTarget[] = [];
  for (const t of targets) {
    const rule = rules.find((r) => ruleMatches(r.match, t));
    ruleOf.set(t.key, rule?.id ?? null);
    if (rule) claimed.get(rule.id)!.push(t); else free.push(t);
  }
  for (const r of rules) if (!claimed.get(r.id)!.length) warnings.push({ code: 'rule_unused', ruleId: r.id });

  // 2) Reglas de monto fijo.
  let fixed = 0;
  const weighted: { t: AllocTarget; w: number }[] = [];
  const refOf = (t: AllocTarget, which: 'list' | 'cost') => {
    const v = which === 'list' ? t.list : t.cost;
    return v !== null && v !== undefined && v > 0 ? v : null;
  };
  /** Peso de cada destino de un grupo según su referencia; los que no tienen usan el promedio de los demás (o 1). */
  const refWeights = (group: AllocTarget[], which: 'list' | 'cost', mult: number) => {
    const known = group.map((t) => refOf(t, which)).filter((v): v is number => v !== null);
    const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
    return group.map((t) => ({ t, w: (refOf(t, which) ?? avg) * mult }));
  };

  for (const r of rules) {
    const group = claimed.get(r.id)!;
    if (!group.length) continue;
    const Q = group.reduce((a, t) => a + t.qty, 0);
    switch (r.method) {
      case 'unit_amount':
        for (const t of group) { perUnit.set(t.key, r.value); fixed += r.value * t.qty; }
        break;
      case 'group_total':
      case 'percent': {
        const amount = r.method === 'group_total' ? r.value : (pool * r.value) / 100;
        if (Q > 0) { for (const t of group) perUnit.set(t.key, amount / Q); fixed += amount; }
        else { for (const t of group) perUnit.set(t.key, 0); warnings.push({ code: 'empty_group', ruleId: r.id }); }
        break;
      }
      case 'weight': for (const t of group) weighted.push({ t, w: r.value }); break;
      case 'by_list': weighted.push(...refWeights(group, 'list', r.value || 1)); break;
      case 'by_cost': weighted.push(...refWeights(group, 'cost', r.value || 1)); break;
    }
  }

  // 3) Destinos sin regla: pesan según la base.
  if (base === 'equal') for (const t of free) weighted.push({ t, w: 1 });
  else weighted.push(...refWeights(free, base === 'by_list' ? 'list' : 'cost', 1));

  // 4) Lo que queda se reparte por peso.
  const remainder = pool - fixed - frozen;
  const W = weighted.reduce((a, x) => a + x.w * x.t.qty, 0);
  let weightedAssigned = 0;
  if (remainder < -0.005) warnings.push({ code: 'over_allocated', amount: r2(-remainder) });
  if (W > 0) {
    const distributable = Math.max(0, remainder);
    for (const { t, w } of weighted) perUnit.set(t.key, (distributable * w) / W);
    weightedAssigned = distributable;
  } else {
    for (const { t } of weighted) perUnit.set(t.key, 0);
  }
  const assigned = frozen + fixed + weightedAssigned;
  const difference = pool - assigned;
  if (difference > 0.005 && W === 0) warnings.push({ code: 'unallocated', amount: r2(difference) });

  const total = new Map<string, number>();
  for (const t of targets) {
    const u = r4(perUnit.get(t.key) ?? 0);
    perUnit.set(t.key, u);
    total.set(t.key, r4(u * t.qty));
  }
  return {
    perUnit, total, ruleOf,
    summary: { pool: r2(pool), frozen: r2(frozen), fixed: r2(fixed), remainder: r2(remainder), assigned: r2(assigned), difference: r2(difference), weightedQty: weighted.reduce((a, x) => a + x.t.qty, 0) },
    warnings,
  };
}

/**
 * Redondea a centavos manteniendo el total EXACTO (método del mayor residuo): útil para precios de un pedido,
 * donde la suma de los renglones debe ser igual al total acordado.
 */
export function distributeCents(values: number[], target: number): number[] {
  const cents = values.map((v) => Math.floor(v * 100 + 1e-9));
  const want = Math.round(target * 100);
  let missing = want - cents.reduce((a, b) => a + b, 0);
  const order = values.map((v, i) => ({ i, frac: v * 100 - cents[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; missing > 0 && order.length; k = (k + 1) % order.length) { cents[order[k]!.i]! += 1; missing--; }
  return cents.map((c) => c / 100);
}
