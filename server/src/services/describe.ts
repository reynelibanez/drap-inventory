import type { Db } from '../db.js';
import type { AppLanguage } from '../config.js';

type I18n = Record<string, string>;

export interface LabelIndex {
  items: Map<number, { name: I18n; code: string | null }>;
  attrs: Map<string, { label: I18n; unit: string | null; dataType: string }>;
  types: Map<number, { name: I18n; key: string }>;
  typeAttrs: Map<number, { key: string; inLotLine: boolean }[]>;
}

export const tr = (v: I18n | null | undefined, lang: AppLanguage): string => (v ? v[lang] ?? v.es ?? v.en ?? Object.values(v)[0] ?? '' : '');

/** Índice de nombres (valores de catálogo, atributos, tipos) para armar textos legibles en PDF. */
export async function loadLabelIndex(db: Db): Promise<LabelIndex> {
  const items = await db.rows<any>('SELECT id, name, code FROM catalog_items');
  const attrs = await db.rows<any>('SELECT key, label, unit, data_type AS "dataType" FROM attribute_definitions');
  const types = await db.rows<any>('SELECT id, key, name FROM equipment_types');
  const typeAttrs = await db.rows<any>(
    `SELECT eta.equipment_type_id AS "typeId", a.key, eta.in_lot_line AS "inLotLine"
       FROM equipment_type_attributes eta JOIN attribute_definitions a ON a.id = eta.attribute_id WHERE eta.is_active ORDER BY eta.sort_order`);
  const ta = new Map<number, { key: string; inLotLine: boolean }[]>();
  for (const r of typeAttrs) (ta.get(r.typeId) ?? ta.set(r.typeId, []).get(r.typeId)!).push({ key: r.key, inLotLine: r.inLotLine });
  return {
    items: new Map(items.map((i: any) => [i.id, { name: i.name, code: i.code }])),
    attrs: new Map(attrs.map((a: any) => [a.key, { label: a.label, unit: a.unit, dataType: a.dataType }])),
    types: new Map(types.map((t: any) => [t.id, { name: t.name, key: t.key }])),
    typeAttrs: ta,
  };
}

/** Partes legibles de las especificaciones de un equipo: ["Dell", "Latitude 7490", "16 GB", ...]. */
export function describeSpecs(idx: LabelIndex, typeId: number, specs: Record<string, any>, lang: AppLanguage, lineOnly = true): string[] {
  const out: string[] = [];
  for (const ta of idx.typeAttrs.get(typeId) ?? []) {
    if (lineOnly && !ta.inLotLine) continue;
    const v = specs?.[ta.key];
    if (v === undefined || v === null) continue;
    const def = idx.attrs.get(ta.key);
    if (!def) continue;
    if (def.dataType === 'select') out.push(tr(idx.items.get(Number(v))?.name, lang));
    else if (def.dataType === 'multiselect') out.push((v as number[]).map((id) => tr(idx.items.get(id)?.name, lang)).join('/'));
    else if (def.dataType === 'boolean') out.push(`${tr(def.label, lang)}: ${v ? (lang === 'es' ? 'Sí' : 'Yes') : 'No'}`);
    else if (def.dataType === 'number') out.push(`${v}${def.unit ? ' ' + def.unit : ''}`);
    else out.push(String(v));
  }
  return out.filter(Boolean);
}

export const typeName = (idx: LabelIndex, typeId: number, lang: AppLanguage) => tr(idx.types.get(typeId)?.name, lang);
export const itemName = (idx: LabelIndex, id: number | null, lang: AppLanguage) => (id ? tr(idx.items.get(id)?.name, lang) : '');
export const itemCode = (idx: LabelIndex, id: number | null) => (id ? idx.items.get(id)?.code ?? '' : '');
