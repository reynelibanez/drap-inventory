import type { Db } from '../db.js';
import { MODEL_DATA } from '../seed/modelData.js';

/**
 * El atributo "Modelo" es una lista desplegable (select) que depende de la marca elegida:
 *  - cada tipo de equipo tiene su propio catálogo "Modelos de …" (`model_<tipo>`), cuyos valores pertenecen a una marca
 *    (`catalog_items.parent_item_id`), y el tipo lo usa para su atributo Modelo (`equipment_type_attributes.catalog_id`);
 *  - el atributo tiene además un catálogo general "Modelos" (`model`) que usan los tipos que no tengan uno propio
 *    (la base de datos exige que un atributo de lista tenga catálogo).
 * En el equipo se guarda el id del modelo (igual que la marca, el procesador, la RAM...).
 */

/** Clave del catálogo de modelos de un tipo de equipo: `model_laptop`, `model_monitor`… */
export const modelCatalogKey = (typeKey: string): string => `model_${typeKey}`;
/** Catálogo general de modelos (lista por omisión del atributo). */
export const BASE_MODEL_KEY = 'model';
const KEY_MAX = 50;

type I18n = { es?: string; en?: string };

async function ensureCatalog(db: Db, companyId: number, key: string, name: I18n, parentCatalogId: number | null): Promise<number> {
  const found = await db.opt<{ id: number }>('SELECT id FROM catalogs WHERE key = $1', [key]);
  if (found) return found.id;
  const r = await db.one<{ id: number }>(
    `INSERT INTO catalogs (company_id, key, name, parent_catalog_id, sort_order)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(sort_order), 0) + 1 FROM catalogs)) RETURNING id`,
    [companyId, key, JSON.stringify(name), parentCatalogId]);
  return r.id;
}

const brandCatalogId = async (db: Db): Promise<number | null> => (await db.opt<{ id: number }>(`SELECT id FROM catalogs WHERE key = 'brand'`))?.id ?? null;

const ensureBaseModelCatalog = async (db: Db, companyId: number): Promise<number> =>
  ensureCatalog(db, companyId, BASE_MODEL_KEY, { es: 'Modelos', en: 'Models' }, await brandCatalogId(db));

/**
 * Asegura que el tipo de equipo tenga su catálogo "Modelos de …" (dependiente del catálogo de marcas) y que su atributo "Modelo" lo use.
 * Idempotente: lo que ya existe no se toca. Devuelve el id del catálogo (o null si no se pudo crear).
 */
export async function ensureTypeModelCatalog(db: Db, companyId: number, type: { id: number; key: string; name: I18n }): Promise<number | null> {
  const key = modelCatalogKey(type.key);
  if (key.length > KEY_MAX) return null;
  const es = type.name.es ?? type.key;
  const en = type.name.en ?? es;
  const catalogId = await ensureCatalog(db, companyId, key, { es: `Modelos de ${es}`, en: `${en} models` }, await brandCatalogId(db));

  // Atributo "Modelo" de lista: este tipo usa su propio catálogo.
  await db.query(
    `UPDATE equipment_type_attributes eta SET catalog_id = $2
       FROM attribute_definitions ad
      WHERE eta.attribute_id = ad.id AND eta.equipment_type_id = $1 AND ad.key = 'model' AND ad.data_type = 'select' AND eta.catalog_id IS NULL`,
    [type.id, catalogId]);
  // (Por compatibilidad) si el atributo todavía fuera de texto, sugiere valores de este catálogo.
  await db.query(
    `UPDATE equipment_type_attributes eta SET suggest_catalog_id = $2
       FROM attribute_definitions ad
      WHERE eta.attribute_id = ad.id AND eta.equipment_type_id = $1 AND ad.key = 'model' AND ad.data_type = 'text' AND eta.suggest_catalog_id IS NULL`,
    [type.id, catalogId]);
  return catalogId;
}

/** Carga en el catálogo los modelos más vendidos de cada marca (los que no existan ya). Devuelve cuántos agregó. */
async function loadModels(db: Db, companyId: number, catalogId: number, data: Record<string, string[]>): Promise<number> {
  const brandCatalog = await db.opt<{ parent_catalog_id: number | null }>('SELECT parent_catalog_id FROM catalogs WHERE id = $1', [catalogId]);
  if (!brandCatalog?.parent_catalog_id) return 0;
  const brands = await db.rows<{ id: number; name: string }>(
    `SELECT id, lower(name->>'es') AS name FROM catalog_items WHERE catalog_id = $1`, [brandCatalog.parent_catalog_id]);
  const brandId = new Map(brands.map((b) => [b.name, b.id]));

  const next = await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM catalog_items WHERE catalog_id = $1', [catalogId]);
  let order = next.n;
  const parents: number[] = []; const names: string[] = []; const orders: number[] = [];
  for (const [brand, models] of Object.entries(data)) {
    const parent = brandId.get(brand.toLowerCase());
    if (!parent) continue; // marca que la empresa no tiene: se omite
    for (const m of models) { parents.push(parent); names.push(m); orders.push(order++); }
  }
  if (!names.length) return 0;
  const r = await db.query(
    `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, name, sort_order)
     SELECT $1, $2, x.parent, jsonb_build_object('es', x.name, 'en', x.name), x.ord
       FROM unnest($3::bigint[], $4::text[], $5::int[]) AS x(parent, name, ord)
      WHERE NOT EXISTS (SELECT 1 FROM catalog_items i WHERE i.catalog_id = $2 AND i.parent_item_id = x.parent AND lower(i.name->>'es') = lower(x.name))`,
    [companyId, catalogId, parents, names, orders]);
  return r.rowCount ?? 0;
}

export const setSeeded = (db: Db, companyId: number, flag: string) => db.query(
  `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || jsonb_build_object($2::text, true)) WHERE id = $1`,
  [companyId, flag]);

export const isSeeded = async (db: Db, companyId: number, flag: string): Promise<boolean> =>
  !!(await db.opt<{ done: boolean }>(`SELECT COALESCE((settings->'_seeded'->>$2)::boolean, false) AS done FROM companies WHERE id = $1`, [companyId, flag]))?.done;

// ---------------------------------------------------------------------------------------------------------------------
// Conversión del atributo "Modelo" de texto a lista
// ---------------------------------------------------------------------------------------------------------------------

const normModel = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Tablas con `specs` y tipo de equipo, donde el modelo se guarda como texto. */
const SPEC_TABLES = ['units', 'lot_lines', 'assets', 'order_lines'] as const;

/**
 * Convierte el modelo guardado como texto en cada equipo, línea de lote, activo y línea de pedido al id del modelo en el catálogo de su
 * tipo y su marca (los que no existen se crean bajo su marca). Un texto vacío simplemente se quita.
 */
async function convertModelValues(db: Db, attributeId: number, baseCatalogId: number): Promise<void> {
  const own = new Map((await db.rows<{ type_id: number; catalog_id: number | null }>(
    'SELECT equipment_type_id AS type_id, catalog_id FROM equipment_type_attributes WHERE attribute_id = $1', [attributeId])).map((r) => [r.type_id, r.catalog_id]));
  const brandCat = await brandCatalogId(db);
  const brandIds = new Set(brandCat ? (await db.rows<{ id: number }>('SELECT id FROM catalog_items WHERE catalog_id = $1', [brandCat])).map((r) => r.id) : []);

  const combos = await db.rows<{ type_id: number; brand: number | null; model: string }>(
    `SELECT DISTINCT type_id, brand, model FROM (
       ${SPEC_TABLES.map((t) => `SELECT equipment_type_id AS type_id,
              CASE WHEN jsonb_typeof(specs->'brand') = 'number' THEN (specs->>'brand')::bigint END AS brand,
              btrim(regexp_replace(specs->>'model', '\\s+', ' ', 'g')) AS model
         FROM ${t} WHERE jsonb_typeof(specs->'model') = 'string'`).join('\n       UNION ALL\n       ')}
     ) x WHERE model <> ''`);

  const cache = new Map<string, number>();
  const resolve = async (typeId: number, brand: number | null, model: string): Promise<number> => {
    const catalogId = own.get(typeId) ?? baseCatalogId;
    const parent = brand !== null && brandIds.has(brand) ? brand : null;
    const ck = `${catalogId}|${parent ?? ''}|${model.toLowerCase()}`;
    const hit = cache.get(ck);
    if (hit) return hit;
    // Primero el que ya existe bajo esa marca; si el equipo no tenía marca, cualquiera con ese nombre.
    const found = await db.opt<{ id: number }>(
      `SELECT id FROM catalog_items
        WHERE catalog_id = $1 AND (parent_item_id IS NOT DISTINCT FROM $2::bigint OR $2::bigint IS NULL)
          AND (lower(name->>'es') = lower($3::text) OR lower(name->>'en') = lower($3::text))
        ORDER BY (parent_item_id IS NOT DISTINCT FROM $2::bigint) DESC, id LIMIT 1`, [catalogId, parent, model]);
    const id = found?.id ?? (await db.one<{ id: number }>(
      `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, name, sort_order)
       SELECT app_company_id(), $1, $2::bigint, jsonb_build_object('es', $3::text, 'en', $3::text),
              (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $1)
       RETURNING id`, [catalogId, parent, model])).id;
    cache.set(ck, id);
    return id;
  };

  const typeIds: number[] = []; const brands: (number | null)[] = []; const models: string[] = []; const items: number[] = [];
  for (const c of combos) {
    typeIds.push(c.type_id); brands.push(c.brand); models.push(c.model); items.push(await resolve(c.type_id, c.brand, c.model));
  }
  for (const t of SPEC_TABLES) {
    if (items.length) {
      await db.query(
        `UPDATE ${t} t SET specs = jsonb_set(t.specs, '{model}', to_jsonb(m.item_id))
           FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::bigint[]) AS m(type_id, brand, model, item_id)
          WHERE jsonb_typeof(t.specs->'model') = 'string' AND t.equipment_type_id = m.type_id
            AND btrim(regexp_replace(t.specs->>'model', '\\s+', ' ', 'g')) = m.model
            AND (CASE WHEN jsonb_typeof(t.specs->'brand') = 'number' THEN (t.specs->>'brand')::bigint END) IS NOT DISTINCT FROM m.brand`,
        [typeIds, brands, models, items]);
    }
    // Lo que quede como texto es un modelo vacío: se quita.
    await db.query(`UPDATE ${t} SET specs = specs - 'model' WHERE jsonb_typeof(specs->'model') = 'string'`);
  }

  await convertRuleMatches(db);
}

/** Reglas guardadas (precios, planes de reparto de costos) que filtraban por modelo con texto: ahora con el id del modelo. */
async function convertRuleMatches(db: Db): Promise<void> {
  const models = await db.rows<{ id: number; parent: number | null; name: string }>(
    `SELECT ci.id, ci.parent_item_id AS parent, lower(ci.name->>'es') AS name
       FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id WHERE c.key = $1 OR c.key LIKE 'model\\_%'`, [BASE_MODEL_KEY]);
  const find = (name: string, brand: unknown): number | undefined => {
    const n = normModel(name).toLowerCase();
    const same = models.filter((m) => m.name === n);
    return (typeof brand === 'number' ? same.find((m) => m.parent === brand) : undefined)?.id ?? same[0]?.id;
  };
  let touched = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const specs = o.specs;
    if (specs && typeof specs === 'object' && !Array.isArray(specs) && 'model' in (specs as object)) {
      const s = specs as Record<string, unknown>;
      const raw = s.model;
      const conv = (x: unknown) => (typeof x === 'string' ? find(x, s.brand) : x);
      if (typeof raw === 'string' || (Array.isArray(raw) && raw.some((x) => typeof x === 'string'))) {
        const next = Array.isArray(raw) ? raw.map(conv).filter((x) => x !== undefined) : conv(raw);
        if (next === undefined || (Array.isArray(next) && !next.length)) delete s.model; else s.model = next;
        touched = true;
      }
    }
    Object.values(o).forEach(walk);
  };
  const sources: [string, string][] = [['price_rules', 'match'], ['cost_templates', 'plan'], ['lots', 'cost_plan']];
  for (const [table, col] of sources) {
    const rows = await db.rows<{ id: number; doc: unknown }>(`SELECT id, ${col} AS doc FROM ${table} WHERE ${col}::text LIKE '%"model"%'`);
    for (const r of rows) {
      touched = false;
      walk(r.doc);
      if (touched) await db.query(`UPDATE ${table} SET ${col} = $2::jsonb WHERE id = $1`, [r.id, JSON.stringify(r.doc)]);
    }
  }
}

/**
 * Deja el atributo "Modelo" como lista desplegable ligada a la marca: catálogo general + un catálogo por tipo, y convierte los datos
 * guardados con texto. Idempotente (si ya es de lista solo completa lo que falte).
 */
export async function convertModelToSelect(db: Db, companyId: number): Promise<void> {
  const attr = await db.opt<{ id: number; data_type: string }>(`SELECT id, data_type FROM attribute_definitions WHERE key = 'model'`);
  if (attr) {
    const base = await ensureBaseModelCatalog(db, companyId);
    const converting = attr.data_type === 'text';
    if (converting) await db.query(`UPDATE attribute_definitions SET data_type = 'select', catalog_id = $2 WHERE id = $1`, [attr.id, base]);
    if (attr.data_type === 'text' || attr.data_type === 'select') {
      const types = await db.rows<{ id: number; key: string; name: I18n }>(
        `SELECT et.id, et.key, et.name FROM equipment_types et JOIN equipment_type_attributes eta ON eta.equipment_type_id = et.id
          WHERE eta.attribute_id = $1 ORDER BY et.sort_order, et.id`, [attr.id]);
      for (const t of types) await ensureTypeModelCatalog(db, companyId, t);
      if (converting) {
        await convertModelValues(db, attr.id, base);
        await db.query('UPDATE equipment_type_attributes SET suggest_catalog_id = NULL WHERE attribute_id = $1', [attr.id]);
      }
    }
  }
  await setSeeded(db, companyId, 'modelSelect');
}

// ---------------------------------------------------------------------------------------------------------------------

/** Crea los catálogos de modelos de todos los tipos de equipo de la empresa y los llena con los más vendidos por marca. */
export async function seedModelCatalogs(db: Db, companyId: number): Promise<void> {
  await convertModelToSelect(db, companyId);
  const types = await db.rows<{ id: number; key: string; name: I18n }>('SELECT id, key, name FROM equipment_types ORDER BY sort_order, id');
  for (const t of types) {
    const catalogId = await ensureTypeModelCatalog(db, companyId, t);
    const data = MODEL_DATA[t.key];
    if (catalogId && data) await loadModels(db, companyId, catalogId, data);
  }
  await setSeeded(db, companyId, 'models');
}

/**
 * Empresas creadas antes de existir los catálogos de modelos (o de que el modelo fuera una lista): los crean/convierten una sola vez
 * (si la empresa borra un catálogo, no se recrea).
 */
export async function ensureModelCatalogs(db: Db, companyId: number): Promise<void> {
  if (!(await isSeeded(db, companyId, 'models'))) { await seedModelCatalogs(db, companyId); return; }
  if (!(await isSeeded(db, companyId, 'modelSelect'))) await convertModelToSelect(db, companyId);
}
