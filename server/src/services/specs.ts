import type { Db } from '../db.js';
import { AppError } from '../errors.js';

export interface AttrConf {
  attributeId: number;
  key: string;
  dataType: 'text' | 'number' | 'boolean' | 'date' | 'select' | 'multiselect';
  /** Catálogo de valores de la lista: el propio de este tipo de equipo (p. ej. los modelos del tipo) o, si no tiene, el del atributo. */
  catalogId: number | null;
  /** Catálogo del que el campo de texto sugiere valores (p. ej. los modelos del tipo). */
  suggestCatalogId?: number | null;
  inLotLine: boolean;
  requiredOnLot: boolean;
  requiredOnTest: boolean;
}

export type SpecStage = 'lot' | 'draft' | 'test';
export type Specs = Record<string, string | number | boolean | number[]>;

/** Atributos activos de un tipo de equipo. */
export async function loadTypeAttrs(db: Db, equipmentTypeId: number): Promise<AttrConf[]> {
  const type = await db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [equipmentTypeId]);
  if (!type) throw new AppError(400, 'invalid_equipment_type');
  return db.rows<AttrConf>(
    `SELECT a.id AS "attributeId", a.key, a.data_type AS "dataType", COALESCE(eta.catalog_id, a.catalog_id) AS "catalogId", eta.suggest_catalog_id AS "suggestCatalogId",
            eta.in_lot_line AS "inLotLine", eta.required_on_lot AS "requiredOnLot", eta.required_on_test AS "requiredOnTest"
       FROM equipment_type_attributes eta
       JOIN attribute_definitions a ON a.id = eta.attribute_id AND a.is_active
      WHERE eta.equipment_type_id = $1 AND eta.is_active
      ORDER BY eta.sort_order`, [equipmentTypeId]);
}

const bad = (code: string, attribute: string, extra: Record<string, unknown> = {}) => new AppError(400, code, { attribute, ...extra });

/**
 * Valida y normaliza los atributos de un equipo o línea de lote contra la
 * configuración de su tipo (lo que el usuario definió en catálogos).
 *  - lot:   línea de lote (exige los obligatorios "al registrar lote")
 *  - draft: equipo en testeo (no exige nada todavía)
 *  - test:  al terminar el testeo (exige los obligatorios "al testear")
 * `only` restringe a los atributos de la línea de lote (in_lot_line).
 */
export async function normalizeSpecs(
  db: Db,
  equipmentTypeId: number,
  input: Record<string, unknown> | null | undefined,
  stage: SpecStage,
  opts: { onlyLotLine?: boolean; attrs?: AttrConf[] } = {},
): Promise<Specs> {
  const attrs = opts.attrs ?? (await loadTypeAttrs(db, equipmentTypeId));
  const byKey = new Map(attrs.map((a) => [a.key, a]));
  const data = input ?? {};
  const out: Specs = {};

  for (const [k, raw] of Object.entries(data)) {
    const a = byKey.get(k);
    if (!a) throw bad('unknown_attribute', k);
    if (opts.onlyLotLine && !a.inLotLine) throw bad('attribute_not_for_lot_line', k);
    if (raw === null || raw === undefined || raw === '') continue;

    switch (a.dataType) {
      case 'text': {
        const s = String(raw).trim();
        if (s.length > 300) throw bad('value_too_long', k);
        if (s) out[k] = s;
        break;
      }
      case 'number': {
        const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
        if (!Number.isFinite(n)) throw bad('invalid_number', k);
        out[k] = n;
        break;
      }
      case 'boolean':
        if (typeof raw !== 'boolean') throw bad('invalid_boolean', k);
        out[k] = raw;
        break;
      case 'date': {
        const s = String(raw);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('invalid_date', k);
        out[k] = s;
        break;
      }
      case 'select': {
        const id = Number(raw);
        if (!Number.isInteger(id)) throw bad('invalid_catalog_value', k);
        out[k] = id;
        break;
      }
      case 'multiselect': {
        if (!Array.isArray(raw)) throw bad('invalid_catalog_value', k);
        const ids = raw.map(Number);
        if (ids.some((n) => !Number.isInteger(n))) throw bad('invalid_catalog_value', k);
        if (ids.length) out[k] = [...new Set(ids)];
        break;
      }
    }
  }

  // Los valores de catálogo deben existir, estar activos y ser del catálogo del atributo (del de este tipo de equipo, si tiene uno propio).
  for (const a of attrs) {
    const v = out[a.key];
    if (v === undefined || !a.catalogId) continue;
    const ids = Array.isArray(v) ? v : [v as number];
    const found = await db.rows<{ id: number; parent: number | null }>(
      'SELECT id, parent_item_id AS parent FROM catalog_items WHERE catalog_id = $1 AND id = ANY($2::bigint[]) AND is_active', [a.catalogId, ids]);
    if (found.length !== ids.length) throw bad('invalid_catalog_value', a.key);
    // Una lista que depende de otra (modelo → marca): el valor debe ser de la marca elegida en este mismo equipo.
    const parentCatalog = (await db.opt<{ p: number | null }>('SELECT parent_catalog_id AS p FROM catalogs WHERE id = $1', [a.catalogId]))?.p;
    if (!parentCatalog) continue;
    const parentAttr = attrs.find((x) => x.dataType === 'select' && x.catalogId === parentCatalog);
    const chosen = parentAttr ? out[parentAttr.key] : undefined;
    if (typeof chosen === 'number' && found.some((f) => f.parent !== null && f.parent !== chosen)) throw bad('catalog_parent_mismatch', a.key, { parent: parentAttr!.key });
  }

  if (stage !== 'draft') {
    for (const a of attrs) {
      if (opts.onlyLotLine && !a.inLotLine) continue;
      const required = stage === 'lot' ? a.requiredOnLot : a.requiredOnTest;
      if (required && out[a.key] === undefined) throw bad('required_attribute', a.key);
    }
  }
  await learnSuggestions(db, attrs, out);
  return out;
}

/**
 * Aprendizaje de modelos: si un campo de texto sugiere valores de un catálogo (p. ej. "Modelo" → "Modelos de Laptop")
 * y el usuario escribió uno que no existe, se guarda en el catálogo (bajo su marca) para poder elegirlo la próxima vez.
 * Corre dentro de la misma transacción que el guardado del equipo, así que si este falla tampoco se crea el modelo.
 */
async function learnSuggestions(db: Db, attrs: AttrConf[], specs: Specs): Promise<void> {
  for (const a of attrs) {
    const raw = specs[a.key];
    if (a.dataType !== 'text' || !a.suggestCatalogId || typeof raw !== 'string') continue;
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 200) continue;
    const cat = await db.opt<{ parent_catalog_id: number | null }>('SELECT parent_catalog_id FROM catalogs WHERE id = $1', [a.suggestCatalogId]);
    if (!cat) continue;
    let parent: number | null = null;
    if (cat.parent_catalog_id) {
      // El catálogo depende de otro (modelos → marcas): hace falta la marca elegida en este mismo equipo.
      const parentAttr = attrs.find((x) => x.dataType === 'select' && x.catalogId === cat.parent_catalog_id);
      const v = parentAttr ? specs[parentAttr.key] : undefined;
      if (typeof v !== 'number') continue;
      parent = v;
    }
    await db.query(
      `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, name, sort_order)
       SELECT app_company_id(), $1, $2::bigint, jsonb_build_object('es', $3::text, 'en', $3::text),
              (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $1)
        WHERE NOT EXISTS (SELECT 1 FROM catalog_items i WHERE i.catalog_id = $1 AND i.parent_item_id IS NOT DISTINCT FROM $2::bigint
                           AND (lower(i.name->>'es') = lower($3::text) OR lower(i.name->>'en') = lower($3::text)))`,
      [a.suggestCatalogId, parent, name]);
  }
}

/** Nombre corto legible de una especificación para mensajes y etiquetas (usa ids resueltos por la UI). */
export function pickLineSpecs(specs: Specs, attrs: AttrConf[]): Specs {
  const out: Specs = {};
  for (const a of attrs) if (a.inLotLine && specs[a.key] !== undefined) out[a.key] = specs[a.key];
  return out;
}
