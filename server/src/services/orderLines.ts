import type { Db } from '../db.js';

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

/** Líneas de un pedido con cuántos equipos lleva cada una. */
export async function loadLines(db: Db, orderId: number): Promise<OrderLine[]> {
  return db.rows<OrderLine>(
    `SELECT l.id, l.line_no AS "lineNo", l.equipment_type_id AS "equipmentTypeId", l.specs, l.cosmetic_grade_ids AS "cosmeticGradeIds",
            l.functional_grade_ids AS "functionalGradeIds", l.quantity, l.unit_price AS "unitPrice", l.notes,
            (SELECT count(*) FROM sale_items si WHERE si.line_id = l.id AND si.released_at IS NULL)::int AS picked
       FROM order_lines l WHERE l.order_id = $1 ORDER BY l.line_no`, [orderId]);
}

/**
 * Elige la línea que corresponde a un equipo: la más específica (más características pedidas) que
 * todavía tenga cupo. Si solo hay líneas que le corresponden pero ya están completas → 'line_full';
 * si ninguna le corresponde → 'no_match'. `taken` lleva la cuenta en memoria al agregar varios seguidos.
 */
export function matchUnit(u: MatchableUnit, lines: OrderLine[], taken: Map<number, number>): { line: OrderLine | null; status: MatchStatus } {
  const fits = lines.filter((l) => unitFitsLine(u, l));
  if (!fits.length) return { line: null, status: 'no_match' };
  const open = fits.filter((l) => l.picked + (taken.get(l.id) ?? 0) < l.quantity)
    .sort((a, b) => Object.keys(b.specs).length - Object.keys(a.specs).length || a.lineNo - b.lineNo);
  if (open.length) return { line: open[0], status: 'ok' };
  return { line: fits[0], status: 'line_full' };
}
