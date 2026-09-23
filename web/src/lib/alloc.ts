/** Tipos y utilidades del reparto de montos (costos del lote y precio total de un pedido). Espejo de server/src/services/allocation.ts. */

export const METHODS = ['unit_amount', 'group_total', 'percent', 'weight', 'by_list', 'by_cost'] as const;
export type Method = (typeof METHODS)[number];
export const BASES = ['equal', 'by_list', 'by_cost'] as const;
export type Base = (typeof BASES)[number];

export interface AllocMatch {
  typeIds?: number[];
  lineIds?: number[];
  cosmeticGradeIds?: number[];
  functionalGradeIds?: number[];
  specs?: Record<string, unknown>;
  unlinked?: boolean;
}
export interface AllocRule { id: string; name?: string; enabled: boolean; match: AllocMatch; method: Method; value: number }
export interface AllocPlan { base: Base; qtyBasis: 'auto' | 'expected' | 'actual'; auto: boolean; rules: AllocRule[] }

export const EMPTY_PLAN: AllocPlan = { base: 'equal', qtyBasis: 'auto', auto: true, rules: [] };

export interface AllocSummary { pool: number; frozen: number; fixed: number; remainder: number; assigned: number; difference: number; weightedQty: number }
export type AllocWarning =
  | { code: 'over_allocated'; amount: number }
  | { code: 'unallocated'; amount: number }
  | { code: 'rule_unused'; ruleId: string }
  | { code: 'empty_group'; ruleId: string };

let seq = 0;
export const newRuleId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function newRule(over: Partial<AllocRule> = {}): AllocRule {
  return { id: newRuleId(), enabled: true, match: {}, method: 'unit_amount', value: 0, ...over };
}

/** ¿Este método necesita un número? (por precio de lista o por costo, no). */
export const methodNeedsValue = (m: Method) => m !== 'by_list' && m !== 'by_cost';

const isEmptySpec = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Quita del plan lo que no filtra nada (listas vacías...) para enviarlo al servidor. */
export function cleanPlan(plan: AllocPlan): AllocPlan {
  return {
    ...plan,
    rules: plan.rules.map((r) => {
      const m: AllocMatch = {};
      if (r.match.typeIds?.length) m.typeIds = r.match.typeIds;
      if (r.match.lineIds?.length) m.lineIds = r.match.lineIds;
      if (r.match.cosmeticGradeIds?.length) m.cosmeticGradeIds = r.match.cosmeticGradeIds;
      if (r.match.functionalGradeIds?.length) m.functionalGradeIds = r.match.functionalGradeIds;
      if (r.match.unlinked) m.unlinked = true;
      const specs = Object.fromEntries(Object.entries(r.match.specs ?? {})
        .map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => x !== '') : v] as const)
        .filter(([, v]) => !isEmptySpec(v)));
      if (Object.keys(specs).length) m.specs = specs;
      return { id: r.id, name: r.name?.trim() || undefined, enabled: r.enabled, match: m, method: r.method, value: methodNeedsValue(r.method) ? Math.max(0, Number(r.value) || 0) : 0 };
    }),
  };
}

/** Resultado de cada regla (cuántos destinos y equipos reclamó y cuánto reparte). */
export interface RuleUse { targets: number; qty: number; total: number }
export function ruleUse(rows: { ruleId: string | null; qty: number; total: number }[]): Record<string, RuleUse> {
  const out: Record<string, RuleUse> = {};
  for (const r of rows) {
    if (!r.ruleId) continue;
    const u = (out[r.ruleId] ??= { targets: 0, qty: 0, total: 0 });
    u.targets++; u.qty += r.qty; u.total += r.total;
  }
  return out;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
