/**
 * Reglas del negocio que la app necesita aplicar sin servidor (a qué línea del pedido corresponde un equipo, totales con
 * descuentos, si un nivel del rack admite un equipo…). Son copias exactas de las funciones del servidor
 * (server/src/services/orderLines.ts, server/src/modules/sales.ts, server/src/services/placement.ts); la prueba
 * `offlineParity.test.ts` del servidor comprueba que siguen dando el mismo resultado.
 */

export type MatchStatus = 'ok' | 'no_match' | 'line_full';

export interface OrderLine {
  id: number;
  lineNo: number;
  equipmentTypeId: number;
  specs: Record<string, unknown>;
  cosmeticGradeIds: number[];
  functionalGradeIds: number[];
  quantity: number;
  unitPrice: number | null;
  notes: string | null;
  picked: number;
}

export interface MatchableUnit {
  id: number;
  equipmentTypeId: number;
  specs: Record<string, unknown>;
  cosmeticGradeId: number | null;
  functionalGradeId: number | null;
}

const norm = (v: unknown): string => String(v).trim().toLowerCase();

/** ¿Los datos del equipo contienen todo lo que pide la línea? (texto sin distinguir mayúsculas; listas: deben estar todos) */
export function specsContain(unitSpecs: Record<string, unknown>, wanted: Record<string, unknown>): boolean {
  for (const [k, w] of Object.entries(wanted)) {
    if (w === null || w === undefined || w === '') continue;
    const have = unitSpecs[k];
    if (have === undefined || have === null) return false;
    if (Array.isArray(w)) {
      const set = new Set((Array.isArray(have) ? have : [have]).map(norm));
      if (!w.every((x) => set.has(norm(x)))) return false;
    } else if (norm(have) !== norm(w)) return false;
  }
  return true;
}

/** ¿El equipo cumple lo que pide la línea (tipo, características y grados)? No mira cuántos van ya. */
export function unitFitsLine(u: MatchableUnit, l: Pick<OrderLine, 'equipmentTypeId' | 'specs' | 'cosmeticGradeIds' | 'functionalGradeIds'>): boolean {
  if (u.equipmentTypeId !== l.equipmentTypeId) return false;
  if (l.cosmeticGradeIds.length && (u.cosmeticGradeId === null || !l.cosmeticGradeIds.includes(u.cosmeticGradeId))) return false;
  if (l.functionalGradeIds.length && (u.functionalGradeId === null || !l.functionalGradeIds.includes(u.functionalGradeId))) return false;
  return specsContain(u.specs, l.specs);
}

/** Línea que corresponde a un equipo: la más específica que aún tenga cupo (`taken` cuenta lo agregado en el mismo lote). */
export function matchUnit(u: MatchableUnit, lines: OrderLine[], taken: Map<number, number>): { line: OrderLine | null; status: MatchStatus } {
  const fits = lines.filter((l) => unitFitsLine(u, l));
  if (!fits.length) return { line: null, status: 'no_match' };
  const open = fits.filter((l) => l.picked + (taken.get(l.id) ?? 0) < l.quantity)
    .sort((a, b) => Object.keys(b.specs).length - Object.keys(a.specs).length || a.lineNo - b.lineNo);
  if (open.length) return { line: open[0], status: 'ok' };
  return { line: fits[0], status: 'line_full' };
}

// ---------------------------------------------------------------- descuentos y cargos

export interface Adjustment { label: string; kind: 'percent' | 'amount'; value: number }
export const money = (n: number): number => Math.round(n * 100) / 100;

export function parseAdjustments(raw: unknown): Adjustment[] {
  if (!Array.isArray(raw)) return [];
  const out: Adjustment[] = [];
  for (const a of raw) {
    if (!a || typeof a.label !== 'string' || !a.label.trim() || (a.kind !== 'percent' && a.kind !== 'amount') || typeof a.value !== 'number' || !Number.isFinite(a.value)) return [];
    out.push({ label: a.label.trim().slice(0, 60), kind: a.kind, value: a.value });
  }
  return out;
}

/** Subtotal + ajustes = total. Cada ajuste devuelve su monto ya calculado. */
export function applyAdjustments(subtotal: number, list: Adjustment[]) {
  const adjustments = list.map((a) => ({ ...a, amount: money(a.kind === 'percent' ? (subtotal * a.value) / 100 : a.value) }));
  return { adjustments, total: money(subtotal + adjustments.reduce((x, a) => x + a.amount, 0)) };
}

// ---------------------------------------------------------------- ubicación

export interface LevelRule { typeId: number | null; cosmeticGradeIds: number[]; functionalGradeIds: number[]; groupBy: string[]; strict: boolean }
export interface PlaceableUnit { id: number; typeId: number; specs: Record<string, unknown>; cosmeticGradeId: number | null; functionalGradeId: number | null }

/** Valor comparable de una propiedad (mayúsculas/espacios no importan; listas se ordenan). */
export function specKey(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (Array.isArray(v)) return [...v].map((x) => String(x).trim().toLowerCase()).sort().join('+');
  return String(v).trim().toLowerCase();
}

/** ¿La regla del nivel admite este equipo? (tipo y grados) */
export function ruleAllows(u: PlaceableUnit, rule: LevelRule | null): boolean {
  if (!rule) return true;
  if (rule.typeId !== null && rule.typeId !== u.typeId) return false;
  if (rule.cosmeticGradeIds.length && (u.cosmeticGradeId === null || !rule.cosmeticGradeIds.includes(u.cosmeticGradeId))) return false;
  if (rule.functionalGradeIds.length && (u.functionalGradeId === null || !rule.functionalGradeIds.includes(u.functionalGradeId))) return false;
  return true;
}

const isExplicit = (r: LevelRule | null) => !!r && (r.typeId !== null || r.cosmeticGradeIds.length > 0 || r.functionalGradeIds.length > 0);
const LEGACY_GROUP = ['brand', 'model'];
export const RULE_BONUS = 500;

export interface PlacementWeights { emptySlot: number; preferredArea: number; sameType: number; sameModel: number; sameGrade: number; fillStarted: number }
export interface Suggestion {
  unitId: number; slotId: number | null; slotCode: string | null; score: number;
  reason: 'same_group' | 'partial_group' | 'same_model' | 'same_brand' | 'same_type' | 'rule_empty' | 'empty_preferred' | 'empty' | 'no_space';
}
export interface SlotState {
  id: number; code: string; areaId: number; order: number; capacity: number; occupied: number;
  preferredTypes: Set<number>; residents: PlaceableUnit[]; rule: LevelRule | null;
}

function prefixDepth(a: PlaceableUnit, b: PlaceableUnit, keys: string[]): number {
  let d = 0;
  for (const k of keys) {
    if (specKey(a.specs[k]) !== specKey(b.specs[k])) break;
    d++;
  }
  return d;
}

function scoreSlot(u: PlaceableUnit, s: SlotState, w: PlacementWeights): { score: number; reason: Suggestion['reason'] } | null {
  if (s.occupied >= s.capacity) return null;
  if (!ruleAllows(u, s.rule)) return null;
  const bonus = isExplicit(s.rule) ? RULE_BONUS : 0;
  if (s.residents.length === 0) {
    const pref = s.preferredTypes.has(u.typeId);
    return { score: w.emptySlot + (pref ? w.preferredArea : 0) + bonus, reason: bonus ? 'rule_empty' : pref ? 'empty_preferred' : 'empty' };
  }
  const same = s.residents.filter((r) => r.typeId === u.typeId);
  if (same.length === 0) return null;
  const custom = !!s.rule && s.rule.groupBy.length > 0;
  const keys = custom ? s.rule!.groupBy : LEGACY_GROUP;
  const depth = Math.max(...same.map((r) => prefixDepth(u, r, keys)));
  if (custom && s.rule!.strict && depth < keys.length) return null;
  const ratio = depth / keys.length;
  if (custom && depth === 0) return { score: w.emptySlot - 1 + bonus, reason: 'same_type' };
  let base = w.sameType + (w.sameModel - w.sameType) * ratio;
  let reason: Suggestion['reason'];
  if (custom) reason = depth === keys.length ? 'same_group' : depth > 0 ? 'partial_group' : 'same_type';
  else reason = depth === keys.length ? 'same_model' : depth > 0 ? 'same_brand' : 'same_type';
  if (depth === keys.length && same.some((r) => r.cosmeticGradeId === u.cosmeticGradeId && r.functionalGradeId === u.functionalGradeId)) base += w.sameGrade;
  if (s.preferredTypes.has(u.typeId)) base += w.preferredArea;
  base += w.fillStarted * (s.occupied / s.capacity);
  return { score: base + bonus, reason };
}

/** Propone un espacio para cada equipo (mismo algoritmo del servidor; trabaja en lote y actualiza la ocupación en memoria). */
export function suggestPlacement(slots: SlotState[], units: PlaceableUnit[], w: PlacementWeights): Suggestion[] {
  const sortKeysByType = new Map<number, string[]>();
  for (const s of slots) {
    if (s.rule?.typeId && s.rule.groupBy.length && !sortKeysByType.has(s.rule.typeId)) sortKeysByType.set(s.rule.typeId, s.rule.groupBy);
  }
  const cmpKeys = (a: PlaceableUnit, b: PlaceableUnit) => {
    for (const k of sortKeysByType.get(a.typeId) ?? LEGACY_GROUP) {
      const c = specKey(a.specs[k]).localeCompare(specKey(b.specs[k]), undefined, { numeric: true });
      if (c) return c;
    }
    return 0;
  };
  const ordered = [...units].sort((a, b) =>
    a.typeId - b.typeId || cmpKeys(a, b) ||
    (a.cosmeticGradeId ?? 0) - (b.cosmeticGradeId ?? 0) || (a.functionalGradeId ?? 0) - (b.functionalGradeId ?? 0));
  const out = new Map<number, Suggestion>();
  for (const u of ordered) {
    let best: { slot: SlotState; score: number; reason: Suggestion['reason'] } | null = null;
    for (const s of slots) {
      const sc = scoreSlot(u, s, w);
      if (!sc) continue;
      if (!best || sc.score > best.score || (sc.score === best.score && s.order < best.slot.order)) best = { slot: s, ...sc };
    }
    if (!best) { out.set(u.id, { unitId: u.id, slotId: null, slotCode: null, score: 0, reason: 'no_space' }); continue; }
    best.slot.occupied++;
    best.slot.residents.push(u);
    out.set(u.id, { unitId: u.id, slotId: best.slot.id, slotCode: best.slot.code, score: Math.round(best.score), reason: best.reason });
  }
  return units.map((u) => out.get(u.id)!);
}

// ---------------------------------------------------------------- precios en bloque

export type Rounding = 'none' | 'unit' | 'five' | 'ten' | 'x99';
/** Redondeo comercial del precio calculado (igual que el servidor). */
export function roundPrice(v: number, how: Rounding): number {
  let r: number;
  switch (how) {
    case 'unit': r = Math.round(v); break;
    case 'five': r = Math.round(v / 5) * 5; break;
    case 'ten': r = Math.round(v / 10) * 10; break;
    case 'x99': r = Math.round(v + 0.01) - 0.01; break;
    default: r = v;
  }
  return Math.max(0, Math.round(r * 100) / 100);
}
