import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { route, zI18n, zId, zIdParam } from '../http.js';
import { ensureTypeModelCatalog } from '../services/modelDefaults.js';
import { getSettings } from '../settings.js';

const key = z.string().trim().min(2).max(50).regex(/^[a-z][a-z0-9_]*$/, 'key_format');
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish();

/** ¿Algún dato guardado apunta a este valor de catálogo (dentro de specs JSON)? */
async function itemUsedInSpecs(db: Db, itemId: number, catalogId: number): Promise<boolean> {
  // Atributos que usan este catálogo, por sí mismos o porque un tipo de equipo lo tiene como su lista propia (p. ej. modelos de laptop).
  const attrs = await db.rows<{ key: string; data_type: string }>(
    `SELECT a.key, a.data_type FROM attribute_definitions a
      WHERE a.catalog_id = $1 OR EXISTS (SELECT 1 FROM equipment_type_attributes e WHERE e.attribute_id = a.id AND e.catalog_id = $1)`, [catalogId]);
  for (const a of attrs) {
    const cond = a.data_type === 'multiselect'
      ? `specs->($1::text) @> to_jsonb($2::bigint)`
      : `specs->>($1::text) = $2::text`;
    for (const table of ['units', 'lot_lines', 'assets']) {
      if (await db.opt(`SELECT 1 FROM ${table} WHERE ${cond} LIMIT 1`, [a.key, itemId])) return true;
    }
  }
  return false;
}

/** El valor de catálogo "padre" (p. ej. la marca de un modelo) debe pertenecer al catálogo del que depende este. */
async function checkParentItem(db: Db, catalogId: number, parentItemId: number | null | undefined): Promise<void> {
  if (parentItemId == null) return;
  const ok = await db.opt(
    `SELECT 1 FROM catalogs c JOIN catalog_items p ON p.catalog_id = c.parent_catalog_id
      WHERE c.id = $1 AND p.id = $2`, [catalogId, parentItemId]);
  if (!ok) throw badRequest('invalid_parent_item');
}

/** Un catálogo puede depender de otro (modelos → marcas), nunca de sí mismo ni en círculo. */
async function checkParentCatalog(db: Db, catalogId: number | null, parentId: number | null | undefined): Promise<void> {
  if (parentId == null) return;
  if (!(await db.opt('SELECT 1 FROM catalogs WHERE id = $1', [parentId]))) throw badRequest('invalid_parent_catalog');
  let cur: number | null = parentId;
  for (let hops = 0; cur != null && hops < 20; hops++) {
    if (cur === catalogId) throw badRequest('invalid_parent_catalog');
    cur = (await db.opt<{ p: number | null }>('SELECT parent_catalog_id AS p FROM catalogs WHERE id = $1', [cur]))?.p ?? null;
  }
}

export async function catalogRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------
  // Metadatos: todo lo que la interfaz necesita para armar formularios.
  // Una sola llamada, se guarda en caché en el navegador.
  // ------------------------------------------------------------------
  app.get('/api/meta', route(null, async (c) => {
    const catalogs = await c.db.rows(
      `SELECT id, key, name, description, is_system AS "isSystem", is_active AS "isActive", sort_order AS "sortOrder",
              parent_catalog_id AS "parentCatalogId"
         FROM catalogs ORDER BY sort_order, id`);
    const items = await c.db.rows(
      `SELECT id, catalog_id AS "catalogId", code, name, description, color, sort_order AS "sortOrder",
              system_key AS "systemKey", meta, is_active AS "isActive", parent_item_id AS "parentItemId"
         FROM catalog_items ORDER BY sort_order, id`);
    const attributes = await c.db.rows(
      `SELECT id, key, label, data_type AS "dataType", catalog_id AS "catalogId", unit, is_system AS "isSystem", is_active AS "isActive"
         FROM attribute_definitions ORDER BY id`);
    const types = await c.db.rows(
      `SELECT id, key, name, icon, tracks_serial AS "tracksSerial", is_system AS "isSystem", is_active AS "isActive", sort_order AS "sortOrder"
         FROM equipment_types ORDER BY sort_order, id`);
    const typeAttrs = await c.db.rows(
      `SELECT id, equipment_type_id AS "equipmentTypeId", attribute_id AS "attributeId", sort_order AS "sortOrder",
              in_lot_line AS "inLotLine", required_on_lot AS "requiredOnLot", required_on_test AS "requiredOnTest", is_active AS "isActive",
              suggest_catalog_id AS "suggestCatalogId", catalog_id AS "catalogId"
         FROM equipment_type_attributes ORDER BY sort_order, id`);
    const s = await getSettings(c.db, c.companyId);
    const company = await c.db.one(
      `SELECT id, name, default_language AS "defaultLanguage", currency, timezone FROM companies WHERE id = $1`, [c.companyId]);

    const byCatalog = new Map<number, any[]>();
    for (const it of items) (byCatalog.get(it.catalogId) ?? byCatalog.set(it.catalogId, []).get(it.catalogId)!).push(it);
    const attrsByType = new Map<number, any[]>();
    for (const ta of typeAttrs) (attrsByType.get(ta.equipmentTypeId) ?? attrsByType.set(ta.equipmentTypeId, []).get(ta.equipmentTypeId)!).push(ta);

    return {
      company,
      settings: s,
      catalogs: catalogs.map((cat) => ({ ...cat, items: byCatalog.get(cat.id) ?? [] })),
      attributes,
      equipmentTypes: types.map((t) => ({ ...t, attributes: attrsByType.get(t.id) ?? [] })),
    };
  }));

  // ------------------------------------------------------------------
  // Catálogos
  // ------------------------------------------------------------------
  app.post('/api/catalogs', route('catalogs.manage', async (c) => {
    const b = c.body(z.object({ key, name: zI18n, description: zI18n.nullish(), parentCatalogId: zId.nullish() }));
    await checkParentCatalog(c.db, null, b.parentCatalogId);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO catalogs (company_id, key, name, description, parent_catalog_id, sort_order)
       VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT max(sort_order) + 1 FROM catalogs), 0)) RETURNING id`,
      [c.companyId, b.key, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null, b.parentCatalogId ?? null]);
    await c.audit('catalog.created', 'catalog', r.id, { key: b.key });
    return { id: r.id };
  }));

  app.patch('/api/catalogs/:id', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      name: zI18n.optional(), description: zI18n.nullable().optional(), isActive: z.boolean().optional(), parentCatalogId: zId.nullable().optional(),
    }));
    const cat = await c.db.opt<{ is_system: boolean; parent_catalog_id: number | null }>('SELECT is_system, parent_catalog_id FROM catalogs WHERE id = $1', [id]);
    if (!cat) throw notFound();
    if (cat.is_system && b.isActive === false) throw badRequest('system_catalog_locked');
    if (b.parentCatalogId !== undefined && b.parentCatalogId !== cat.parent_catalog_id) {
      if (cat.is_system) throw badRequest('system_catalog_locked');
      // Con valores ya asignados a un padre, cambiar de catálogo padre los dejaría sin sentido.
      if (await c.db.opt('SELECT 1 FROM catalog_items WHERE catalog_id = $1 AND parent_item_id IS NOT NULL LIMIT 1', [id])) throw conflict('catalog_parent_in_use');
      await checkParentCatalog(c.db, id, b.parentCatalogId);
    }
    await c.db.query(
      `UPDATE catalogs SET name = COALESCE($2::jsonb, name),
                           description = CASE WHEN $3::boolean THEN $4::jsonb ELSE description END,
                           is_active = COALESCE($5, is_active),
                           parent_catalog_id = CASE WHEN $6::boolean THEN $7::bigint ELSE parent_catalog_id END WHERE id = $1`,
      [id, b.name ? JSON.stringify(b.name) : null, b.description !== undefined, b.description ? JSON.stringify(b.description) : null, b.isActive ?? null,
        b.parentCatalogId !== undefined, b.parentCatalogId ?? null]);
    await c.audit('catalog.updated', 'catalog', id);
    return { ok: true };
  }));

  app.delete('/api/catalogs/:id', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const cat = await c.db.opt<{ is_system: boolean }>('SELECT is_system FROM catalogs WHERE id = $1', [id]);
    if (!cat) throw notFound();
    if (cat.is_system) throw badRequest('system_catalog_locked');
    if (await c.db.opt('SELECT 1 FROM attribute_definitions WHERE catalog_id = $1 LIMIT 1', [id])) throw conflict('catalog_in_use');
    if (await c.db.opt('SELECT 1 FROM equipment_type_attributes WHERE suggest_catalog_id = $1 OR catalog_id = $1 LIMIT 1', [id])) throw conflict('catalog_in_use');
    if (await c.db.opt('SELECT 1 FROM catalogs WHERE parent_catalog_id = $1 LIMIT 1', [id])) throw conflict('catalog_has_children');
    await c.db.query('DELETE FROM catalogs WHERE id = $1', [id]);
    await c.audit('catalog.deleted', 'catalog', id);
    return { ok: true };
  }));

  // ------------------------------------------------------------------
  // Valores de catálogo
  // ------------------------------------------------------------------
  const itemBody = z.object({
    code: z.string().trim().min(1).max(30).nullish(),
    name: zI18n,
    description: zI18n.nullish(),
    color,
    meta: z.record(z.string(), z.unknown()).optional(),
    sortOrder: z.number().int().optional(),
    parentItemId: zId.nullish(),
  });

  app.post('/api/catalogs/:id/items', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(itemBody);
    if (!(await c.db.opt('SELECT 1 FROM catalogs WHERE id = $1', [id]))) throw notFound();
    await checkParentItem(c.db, id, b.parentItemId);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO catalog_items (company_id, catalog_id, code, name, description, color, meta, parent_item_id, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$9, COALESCE($8, (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $2))) RETURNING id`,
      [c.companyId, id, b.code ?? null, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null,
        b.color ?? null, JSON.stringify(b.meta ?? {}), b.sortOrder ?? null, b.parentItemId ?? null]);
    await c.audit('catalog_item.created', 'catalog_item', r.id, { catalogId: id, name: b.name });
    return { id: r.id };
  }));

  /**
   * Alta rápida de un valor (p. ej. un modelo que no estaba, bajo su marca) desde el formulario del equipo.
   * La puede usar quien registra o testea equipos en las listas que dependen de otra (modelos → marcas); para el resto hace falta `catalogs.manage`.
   * Si ya existe uno igual (mismo nombre bajo la misma marca) devuelve ese, así reintentarla sin conexión no duplica nada.
   */
  app.post('/api/catalogs/:id/quick-item', route(['catalogs.manage', 'units.test', 'units.edit', 'lots.create', 'lots.edit'], async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ name: z.string().trim().min(1).max(200), parentItemId: zId.nullish() }));
    if (!(await c.db.opt('SELECT 1 FROM catalogs WHERE id = $1', [id]))) throw notFound();
    // Quien registra o testea equipos solo agrega valores a listas que dependen de otra (los modelos bajo su marca); el resto exige administrar catálogos.
    const isDependentList = await c.db.opt(
      `SELECT 1 FROM catalogs cat WHERE cat.id = $1 AND cat.parent_catalog_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM attribute_definitions a
          WHERE a.data_type = 'select' AND (a.catalog_id = cat.id OR EXISTS (SELECT 1 FROM equipment_type_attributes e WHERE e.attribute_id = a.id AND e.catalog_id = cat.id)))`, [id]);
    if (!isDependentList && !c.can('catalogs.manage')) throw forbidden('missing_permission', { permission: 'catalogs.manage' });
    if (isDependentList && !b.parentItemId && !c.can('catalogs.manage')) throw badRequest('parent_required');
    await checkParentItem(c.db, id, b.parentItemId);
    const name = b.name.replace(/\s+/g, ' ');
    const same = await c.db.opt<{ id: number }>(
      `SELECT id FROM catalog_items WHERE catalog_id = $1 AND parent_item_id IS NOT DISTINCT FROM $2::bigint
          AND (lower(name->>'es') = lower($3::text) OR lower(name->>'en') = lower($3::text)) ORDER BY id LIMIT 1`, [id, b.parentItemId ?? null, name]);
    if (same) return { id: same.id, existed: true };
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO catalog_items (company_id, catalog_id, parent_item_id, name, sort_order)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $2)) RETURNING id`,
      [c.companyId, id, b.parentItemId ?? null, JSON.stringify({ es: name, en: name })]);
    await c.audit('catalog_item.created', 'catalog_item', r.id, { catalogId: id, name, quick: true });
    return { id: r.id, existed: false };
  }));

  app.patch('/api/catalog-items/:id', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(itemBody.partial().extend({ isActive: z.boolean().optional() }));
    const it = await c.db.opt<{ system_key: string | null; catalog_id: number }>('SELECT system_key, catalog_id FROM catalog_items WHERE id = $1', [id]);
    if (!it) throw notFound();
    if (it.system_key && b.isActive === false) throw badRequest('system_item_locked');
    if (b.parentItemId !== undefined) await checkParentItem(c.db, it.catalog_id, b.parentItemId);
    await c.db.query(
      `UPDATE catalog_items SET
         code = CASE WHEN $2::boolean THEN $3 ELSE code END,
         name = COALESCE($4::jsonb, name),
         description = CASE WHEN $5::boolean THEN $6::jsonb ELSE description END,
         color = CASE WHEN $7::boolean THEN $8 ELSE color END,
         meta = COALESCE($9::jsonb, meta),
         sort_order = COALESCE($10, sort_order),
         is_active = COALESCE($11, is_active),
         parent_item_id = CASE WHEN $12::boolean THEN $13::bigint ELSE parent_item_id END
       WHERE id = $1`,
      [id, b.code !== undefined, b.code ?? null, b.name ? JSON.stringify(b.name) : null,
        b.description !== undefined, b.description ? JSON.stringify(b.description) : null,
        b.color !== undefined, b.color ?? null, b.meta ? JSON.stringify(b.meta) : null, b.sortOrder ?? null, b.isActive ?? null,
        b.parentItemId !== undefined, b.parentItemId ?? null]);
    await c.audit('catalog_item.updated', 'catalog_item', id);
    return { ok: true };
  }));

  app.delete('/api/catalog-items/:id', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const it = await c.db.opt<{ system_key: string | null; catalog_id: number }>('SELECT system_key, catalog_id FROM catalog_items WHERE id = $1', [id]);
    if (!it) throw notFound();
    if (it.system_key) throw badRequest('system_item_locked');
    if (await c.db.opt('SELECT 1 FROM catalog_items WHERE parent_item_id = $1 LIMIT 1', [id])) throw conflict('item_has_children');
    if (await itemUsedInSpecs(c.db, id, it.catalog_id)) throw conflict('item_in_use');
    await c.db.query('DELETE FROM catalog_items WHERE id = $1', [id]); // FK: si otro dato lo usa → 409 in_use
    await c.audit('catalog_item.deleted', 'catalog_item', id);
    return { ok: true };
  }));

  app.put('/api/catalogs/:id/order', route('catalogs.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const { ids } = c.body(z.object({ ids: z.array(zId).min(1) }));
    await c.db.query(
      `UPDATE catalog_items ci SET sort_order = o.pos
         FROM unnest($2::bigint[]) WITH ORDINALITY AS o(item_id, pos)
        WHERE ci.id = o.item_id AND ci.catalog_id = $1`, [id, ids]);
    return { ok: true };
  }));

  // ------------------------------------------------------------------
  // Atributos (biblioteca reutilizable)
  // ------------------------------------------------------------------
  const attrBody = z.object({
    key,
    label: zI18n,
    dataType: z.enum(['text', 'number', 'boolean', 'date', 'select', 'multiselect']),
    catalogId: zId.nullish(),
    unit: z.string().trim().max(10).nullish(),
  }).refine((a) => (a.dataType === 'select' || a.dataType === 'multiselect') === !!a.catalogId, { message: 'catalog_required_for_select', path: ['catalogId'] });

  app.post('/api/attributes', route('equipment.manage', async (c) => {
    const b = c.body(attrBody);
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO attribute_definitions (company_id, key, label, data_type, catalog_id, unit) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [c.companyId, b.key, JSON.stringify(b.label), b.dataType, b.catalogId ?? null, b.unit ?? null]);
    await c.audit('attribute.created', 'attribute', r.id, { key: b.key });
    return { id: r.id };
  }));

  app.patch('/api/attributes/:id', route('equipment.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ label: zI18n.optional(), unit: z.string().trim().max(10).nullable().optional(), isActive: z.boolean().optional() }));
    // La clave y el tipo de dato no cambian: hay datos guardados con ellas.
    const r = await c.db.query(
      `UPDATE attribute_definitions SET label = COALESCE($2::jsonb, label),
              unit = CASE WHEN $3::boolean THEN $4 ELSE unit END, is_active = COALESCE($5, is_active) WHERE id = $1`,
      [id, b.label ? JSON.stringify(b.label) : null, b.unit !== undefined, b.unit ?? null, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await c.audit('attribute.updated', 'attribute', id);
    return { ok: true };
  }));

  // ------------------------------------------------------------------
  // Tipos de equipo
  // ------------------------------------------------------------------
  const typeAttrSchema = z.object({
    attributeId: zId,
    inLotLine: z.boolean().default(false),
    requiredOnLot: z.boolean().default(false),
    requiredOnTest: z.boolean().default(false),
    isActive: z.boolean().default(true),
    /** Atributos de texto: catálogo que ofrece sugerencias (p. ej. los modelos de este tipo). */
    suggestCatalogId: zId.nullish(),
    /** Atributos de lista: catálogo propio de este tipo de equipo (si no se manda, se conserva el que tenga). */
    catalogId: zId.nullish(),
  });

  async function saveTypeAttrs(c: { db: Db; companyId: number }, typeId: number, attrs: z.infer<typeof typeAttrSchema>[]) {
    const ids = new Set(attrs.map((a) => a.attributeId));
    if (ids.size !== attrs.length) throw badRequest('duplicate_attribute');
    // Quitar los que ya no están (los valores ya guardados en specs se conservan).
    await c.db.query('DELETE FROM equipment_type_attributes WHERE equipment_type_id = $1 AND NOT (attribute_id = ANY($2::bigint[]))', [typeId, [...ids]]);
    let order = 0;
    for (const a of attrs) {
      if (a.suggestCatalogId != null) {
        const okSuggest = await c.db.opt(
          `SELECT 1 FROM attribute_definitions ad, catalogs cat WHERE ad.id = $1 AND ad.data_type = 'text' AND cat.id = $2`, [a.attributeId, a.suggestCatalogId]);
        if (!okSuggest) throw badRequest('invalid_suggest_catalog');
      }
      if (a.catalogId != null) {
        const okCatalog = await c.db.opt(
          `SELECT 1 FROM attribute_definitions ad, catalogs cat WHERE ad.id = $1 AND ad.data_type IN ('select', 'multiselect') AND cat.id = $2`, [a.attributeId, a.catalogId]);
        if (!okCatalog) throw badRequest('invalid_catalog');
      }
      await c.db.query(
        `INSERT INTO equipment_type_attributes (company_id, equipment_type_id, attribute_id, sort_order, in_lot_line, required_on_lot, required_on_test, is_active, suggest_catalog_id, catalog_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$10,$12)
         ON CONFLICT (equipment_type_id, attribute_id) DO UPDATE
           SET sort_order = EXCLUDED.sort_order, in_lot_line = EXCLUDED.in_lot_line, required_on_lot = EXCLUDED.required_on_lot,
               required_on_test = EXCLUDED.required_on_test, is_active = EXCLUDED.is_active,
               suggest_catalog_id = CASE WHEN $9::boolean THEN EXCLUDED.suggest_catalog_id ELSE equipment_type_attributes.suggest_catalog_id END,
               catalog_id = CASE WHEN $11::boolean THEN EXCLUDED.catalog_id ELSE equipment_type_attributes.catalog_id END`,
        [c.companyId, typeId, a.attributeId, order++, a.inLotLine, a.requiredOnLot, a.requiredOnTest, a.isActive, a.suggestCatalogId !== undefined, a.suggestCatalogId ?? null,
          a.catalogId !== undefined, a.catalogId ?? null]);
    }
  }

  app.post('/api/equipment-types', route('equipment.manage', async (c) => {
    const b = c.body(z.object({
      key, name: zI18n, icon: z.string().trim().max(40).nullish(), tracksSerial: z.boolean().default(true),
      attributes: z.array(typeAttrSchema).default([]),
    }));
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO equipment_types (company_id, key, name, icon, tracks_serial, sort_order)
       VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT max(sort_order) + 1 FROM equipment_types), 0)) RETURNING id`,
      [c.companyId, b.key, JSON.stringify(b.name), b.icon ?? null, b.tracksSerial]);
    await saveTypeAttrs(c, r.id, b.attributes);
    await ensureTypeModelCatalog(c.db, c.companyId, { id: r.id, key: b.key, name: b.name });
    await c.audit('equipment_type.created', 'equipment_type', r.id, { key: b.key });
    return { id: r.id };
  }));

  app.put('/api/equipment-types/:id', route('equipment.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      name: zI18n, icon: z.string().trim().max(40).nullish(), tracksSerial: z.boolean(), isActive: z.boolean().default(true),
      attributes: z.array(typeAttrSchema),
    }));
    const r = await c.db.query('UPDATE equipment_types SET name = $2, icon = $3, tracks_serial = $4, is_active = $5 WHERE id = $1',
      [id, JSON.stringify(b.name), b.icon ?? null, b.tracksSerial, b.isActive]);
    if (!r.rowCount) throw notFound();
    await saveTypeAttrs(c, id, b.attributes);
    await c.audit('equipment_type.updated', 'equipment_type', id);
    return { ok: true };
  }));

  app.delete('/api/equipment-types/:id', route('equipment.manage', async (c) => {
    const { id } = c.params(zIdParam);
    // Se puede borrar solo si nada lo usa (la clave foránea lo garantiza → 409 in_use); si no, desactívalo.
    const r = await c.db.query('DELETE FROM equipment_types WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound();
    await c.audit('equipment_type.deleted', 'equipment_type', id);
    return { ok: true };
  }));
}
