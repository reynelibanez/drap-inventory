import type { Db } from '../db.js';
import type { Settings } from '../settings.js';

/**
 * Ubicación inteligente.
 *
 * Objetivo: que los equipos parecidos queden juntos y que cada espacio reciba lo que
 * le corresponde. Cada NIVEL de un rack puede tener una regla (tabla rack_level_rules):
 *   - tipo de equipo que va en ese nivel (o cualquiera),
 *   - grados cosmético y/o funcional permitidos (vacío = cualquiera),
 *   - "agrupar por": propiedades del tipo, en el orden elegido (p. ej. Marca → Modelo → CPU),
 *   - estricto: un espacio guarda un solo grupo (no se mezclan variantes).
 *
 * Para cada equipo se puntúa cada espacio con lugar:
 *  - La regla del nivel debe permitirlo (tipo y grados); si no, el espacio se descarta.
 *  - Con regla explícita (tipo o grados) suma RULE_BONUS: se prefiere el nivel pensado para ese equipo.
 *  - El espacio ya tiene equipos: se compara con los que hay dentro usando "agrupar por"
 *    (sin regla se usa Marca → Modelo como antes). Cuanto más larga la coincidencia, más puntos.
 *    Si el nivel es estricto y el equipo no coincide en TODAS las propiedades, se descarta.
 *    Equipos de otro tipo nunca se mezclan.
 *  - El espacio está vacío → emptySlot, más preferredArea si el área está marcada para ese tipo.
 * Desempate: orden físico (almacén, área, rack, nivel, espacio) para que sea predecible.
 * Los pesos son ajustes de la empresa (settings.placement).
 */

export interface PlaceableUnit {
  id: number;
  typeId: number;
  specs: Record<string, unknown>;
  cosmeticGradeId: number | null;
  functionalGradeId: number | null;
}

export interface LevelRule {
  typeId: number | null;
  cosmeticGradeIds: number[];
  functionalGradeIds: number[];
  groupBy: string[];
  strict: boolean;
}

export interface Suggestion {
  unitId: number;
  slotId: number | null;
  slotCode: string | null;
  score: number;
  reason: 'same_group' | 'partial_group' | 'same_model' | 'same_brand' | 'same_type' | 'rule_empty' | 'empty_preferred' | 'empty' | 'no_space';
}

export interface SlotState {
  id: number;
  code: string;
  areaId: number;
  order: number;
  capacity: number;
  occupied: number;
  preferredTypes: Set<number>;
  residents: PlaceableUnit[];
  rule: LevelRule | null;
}

/** Bonus de un espacio cuyo nivel fue pensado (regla explícita) para este equipo. */
export const RULE_BONUS = 500;
const LEGACY_GROUP = ['brand', 'model'];

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

/** Cuántas propiedades seguidas (en el orden de agrupación) coinciden entre dos equipos. */
function prefixDepth(a: PlaceableUnit, b: PlaceableUnit, keys: string[]): number {
  let d = 0;
  for (const k of keys) {
    if (specKey(a.specs[k]) !== specKey(b.specs[k])) break;
    d++;
  }
  return d;
}

export const RULE_COLUMNS = `r.equipment_type_id AS "typeId", r.cosmetic_grade_ids AS "cosmeticGradeIds",
       r.functional_grade_ids AS "functionalGradeIds", r.group_by AS "groupBy", r.strict`;

export async function loadPlaceable(db: Db, unitIds: number[]): Promise<PlaceableUnit[]> {
  return db.rows<PlaceableUnit>(
    `SELECT id, equipment_type_id AS "typeId", specs, cosmetic_grade_id AS "cosmeticGradeId", functional_grade_id AS "functionalGradeId"
       FROM units WHERE id = ANY($1::bigint[])`, [unitIds]);
}

async function loadSlots(db: Db, excludeUnitIds: number[]): Promise<SlotState[]> {
  const slots = await db.rows<any>(
    `SELECT s.id, s.code, s.capacity, a.id AS "areaId",
            row_number() OVER (ORDER BY w.code, a.code, r.code, s.level_no, s.slot_no) AS "order",
            COALESCE((SELECT array_agg(aet.equipment_type_id) FROM area_equipment_types aet WHERE aet.area_id = a.id), '{}') AS "preferred",
            CASE WHEN lr.rack_id IS NULL THEN NULL ELSE jsonb_build_object(
              'typeId', lr.equipment_type_id, 'cosmeticGradeIds', to_jsonb(lr.cosmetic_grade_ids),
              'functionalGradeIds', to_jsonb(lr.functional_grade_ids), 'groupBy', to_jsonb(lr.group_by), 'strict', lr.strict) END AS "rule"
       FROM slots s
       JOIN racks r ON r.id = s.rack_id AND r.is_active
       JOIN areas a ON a.id = r.area_id AND a.is_active
       JOIN warehouses w ON w.id = a.warehouse_id AND w.is_active
       LEFT JOIN rack_level_rules lr ON lr.rack_id = s.rack_id AND lr.level_no = s.level_no
      WHERE s.is_active`);
  const residents = await db.rows<any>(
    `SELECT slot_id AS "slotId", id, equipment_type_id AS "typeId", specs,
            cosmetic_grade_id AS "cosmeticGradeId", functional_grade_id AS "functionalGradeId"
       FROM units WHERE slot_id IS NOT NULL AND NOT (id = ANY($1::bigint[]))`, [excludeUnitIds]);
  const map = new Map<number, SlotState>();
  for (const s of slots) {
    map.set(s.id, { id: s.id, code: s.code, areaId: s.areaId, order: Number(s.order), capacity: s.capacity, occupied: 0,
      preferredTypes: new Set<number>(s.preferred), residents: [], rule: s.rule as LevelRule | null });
  }
  for (const r of residents) {
    const st = map.get(r.slotId);
    if (!st) continue; // espacio inactivo
    st.occupied++;
    st.residents.push(r);
  }
  return [...map.values()];
}

function scoreSlot(u: PlaceableUnit, s: SlotState, w: Settings['placement']): { score: number; reason: Suggestion['reason'] } | null {
  if (s.occupied >= s.capacity) return null;
  if (!ruleAllows(u, s.rule)) return null;
  const bonus = isExplicit(s.rule) ? RULE_BONUS : 0;
  if (s.residents.length === 0) {
    const pref = s.preferredTypes.has(u.typeId);
    return { score: w.emptySlot + (pref ? w.preferredArea : 0) + bonus, reason: bonus ? 'rule_empty' : pref ? 'empty_preferred' : 'empty' };
  }
  // Solo se mezcla con el mismo tipo de equipo.
  const same = s.residents.filter((r) => r.typeId === u.typeId);
  if (same.length === 0) return null;

  const custom = !!s.rule && s.rule.groupBy.length > 0;
  const keys = custom ? s.rule!.groupBy : LEGACY_GROUP;
  const depth = Math.max(...same.map((r) => prefixDepth(u, r, keys)));
  if (custom && s.rule!.strict && depth < keys.length) return null; // este espacio es de otro grupo

  const ratio = depth / keys.length;
  // Con "agrupar por" propio, mezclar un grupo distinto es el último recurso: se prefiere abrir un espacio vacío.
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

/**
 * Propone un espacio para cada equipo. Trabaja en lote: al asignar un equipo se
 * actualiza la ocupación en memoria, así los siguientes se agrupan a su lado.
 */
export async function suggestPlacement(db: Db, units: PlaceableUnit[], w: Settings['placement']): Promise<Suggestion[]> {
  return placeUnits(await loadSlots(db, units.map((u) => u.id)), units, w);
}

/** El reparto en sí (sin base de datos): la app usa el mismo algoritmo sin conexión, y una prueba comprueba que den lo mismo. */
export function placeUnits(slots: SlotState[], units: PlaceableUnit[], w: Settings['placement']): Suggestion[] {
  // Orden: por tipo y por las propiedades de agrupación que use ese tipo (o Marca → Modelo), luego grados.
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
    if (!best) {
      out.set(u.id, { unitId: u.id, slotId: null, slotCode: null, score: 0, reason: 'no_space' });
      continue;
    }
    best.slot.occupied++;
    best.slot.residents.push(u);
    out.set(u.id, { unitId: u.id, slotId: best.slot.id, slotCode: best.slot.code, score: Math.round(best.score), reason: best.reason });
  }
  return units.map((u) => out.get(u.id)!);
}

/** Reglas de los niveles donde están (o irían) los espacios indicados: slotId → regla. */
export async function loadSlotRules(db: Db, slotIds: number[]): Promise<Map<number, LevelRule | null>> {
  const rows = await db.rows<any>(
    `SELECT s.id, ${RULE_COLUMNS}, (r.rack_id IS NOT NULL) AS has_rule
       FROM slots s LEFT JOIN rack_level_rules r ON r.rack_id = s.rack_id AND r.level_no = s.level_no
      WHERE s.id = ANY($1::bigint[])`, [slotIds]);
  return new Map(rows.map((r) => [r.id, r.has_rule ? { typeId: r.typeId, cosmeticGradeIds: r.cosmeticGradeIds, functionalGradeIds: r.functionalGradeIds, groupBy: r.groupBy, strict: r.strict } : null]));
}

/**
 * Ubica solo a un equipo recién testeado (o lo mueve si su espacio actual ya no le corresponde).
 * Devuelve el código del espacio, o null si no hay dónde. Nunca lanza por falta de espacio.
 * Debe correr dentro de la transacción de la petición (reintenta si otro usuario llenó el espacio a la vez).
 */
export async function autoPlaceUnit(
  db: Db, unitId: number, w: Settings['placement'],
  audit: (action: string, entity: string, id: number, data?: Record<string, unknown>) => Promise<unknown>,
): Promise<{ slotId: number; slotCode: string; moved: boolean } | null> {
  const [unit] = await loadPlaceable(db, [unitId]);
  if (!unit) return null;
  const cur = await db.opt<{ slot_id: number | null }>('SELECT slot_id FROM units WHERE id = $1', [unitId]);
  if (cur?.slot_id) {
    const rules = await loadSlotRules(db, [cur.slot_id]);
    if (ruleAllows(unit, rules.get(cur.slot_id) ?? null)) {
      const sl = await db.one<{ code: string }>('SELECT code FROM slots WHERE id = $1', [cur.slot_id]);
      return { slotId: cur.slot_id, slotCode: sl.code, moved: false };
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const [sug] = await suggestPlacement(db, [unit], w);
    if (!sug?.slotId) return null;
    const slot = await db.one<{ capacity: number; occupied: number }>(
      `SELECT s.capacity, (SELECT count(*) FROM units x WHERE x.slot_id = s.id AND x.id <> $2)::int AS occupied
         FROM slots s WHERE s.id = $1 FOR UPDATE`, [sug.slotId, unitId]);
    if (slot.occupied >= slot.capacity) continue; // otro se adelantó: se vuelve a calcular
    await db.query('UPDATE units SET slot_id = $2 WHERE id = $1', [unitId, sug.slotId]);
    await audit('unit.moved', 'unit', unitId, { from: cur?.slot_id ?? null, to: sug.slotId, auto: true });
    return { slotId: sug.slotId, slotCode: sug.slotCode!, moved: true };
  }
  return null;
}
