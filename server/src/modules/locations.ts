import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam } from '../http.js';
import { assertLocationLimit } from '../services/billing.js';
import { getSettings } from '../settings.js';
import { lockRows } from '../services/common.js';
import { loadPlaceable, loadSlotRules, ruleAllows, suggestPlacement } from '../services/placement.js';

const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/, 'code_format');
const optText = (n = 300) => z.string().trim().max(n).nullish().transform((v) => (v ? v : null));

/** Regla de un nivel: qué tipo y grados van ahí y cómo se agrupan los equipos (orden de propiedades). */
const ruleSchema = z.object({
  typeId: zId.nullish().transform((v) => v ?? null),
  cosmeticGradeIds: z.array(zId).max(100).default([]),
  functionalGradeIds: z.array(zId).max(100).default([]),
  groupBy: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(12).default([]),
  strict: z.boolean().default(true),
});
type RuleInput = z.infer<typeof ruleSchema>;

const layoutSchema = z.object({
  levels: z.array(z.object({
    slots: z.number().int().min(1).max(200),
    capacity: z.number().int().min(1).max(100000),
    /** undefined = no tocar la regla actual; null = quitarla. */
    rule: ruleSchema.nullish(),
  })).min(1).max(50),
});

/** Comprueba que el tipo, los grados y las propiedades de una regla existan y sean coherentes. */
async function assertRule(c: Ctx, r: RuleInput) {
  if (r.typeId !== null && !(await c.db.opt('SELECT 1 FROM equipment_types WHERE id = $1', [r.typeId]))) throw badRequest('invalid_equipment_type');
  for (const [ids, cat] of [[r.cosmeticGradeIds, 'cosmetic_grade'], [r.functionalGradeIds, 'functional_grade']] as const) {
    const uniq = [...new Set(ids)];
    if (!uniq.length) continue;
    const n = (await c.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM catalog_items ci JOIN catalogs ca ON ca.id = ci.catalog_id WHERE ca.key = $1 AND ci.id = ANY($2::bigint[])`, [cat, uniq])).n;
    if (n !== uniq.length) throw badRequest('invalid_catalog_value', { field: cat });
  }
  if (new Set(r.groupBy).size !== r.groupBy.length) throw badRequest('rule_duplicate_attribute');
  if (r.groupBy.length) {
    const ok = await c.db.rows<{ key: string }>(
      r.typeId !== null
        ? `SELECT a.key FROM equipment_type_attributes eta JOIN attribute_definitions a ON a.id = eta.attribute_id
            WHERE eta.equipment_type_id = $1 AND a.key = ANY($2::text[])`
        : `SELECT a.key FROM attribute_definitions a WHERE a.key = ANY($2::text[]) AND $1::bigint IS NULL`,
      [r.typeId, r.groupBy]);
    if (new Set(ok.map((x) => x.key)).size !== r.groupBy.length) throw badRequest('rule_invalid_attribute');
  }
}

async function recomputeSlotCodes(c: Ctx, where: { rackId?: number; areaId?: number; warehouseId?: number }) {
  await c.db.query(
    `UPDATE slots s SET code = w.code || '/' || a.code || '/' || r.code || '/' || s.level_no || '-' || s.slot_no
       FROM racks r JOIN areas a ON a.id = r.area_id JOIN warehouses w ON w.id = a.warehouse_id
      WHERE r.id = s.rack_id
        AND ($1::bigint IS NULL OR r.id = $1) AND ($2::bigint IS NULL OR a.id = $2) AND ($3::bigint IS NULL OR w.id = $3)`,
    [where.rackId ?? null, where.areaId ?? null, where.warehouseId ?? null]);
}

/** Crea/ajusta/quita espacios de un rack para que coincida con el diseño pedido (nivel → cuántos espacios y su capacidad). */
async function applyLayout(c: Ctx, rackId: number, layout: z.infer<typeof layoutSchema>) {
  const rack = await c.db.opt<{ code: string; area_code: string; wh_code: string }>(
    `SELECT r.code, a.code AS area_code, w.code AS wh_code FROM racks r JOIN areas a ON a.id = r.area_id JOIN warehouses w ON w.id = a.warehouse_id
      WHERE r.id = $1 FOR UPDATE OF r`, [rackId]);
  if (!rack) throw notFound('rack_not_found');
  const existing = await c.db.rows<{ id: number; level_no: number; slot_no: number; capacity: number; occupied: number; code: string }>(
    `SELECT s.id, s.level_no, s.slot_no, s.capacity, s.code, (SELECT count(*) FROM units u WHERE u.slot_id = s.id)::int AS occupied
       FROM slots s WHERE s.rack_id = $1 FOR UPDATE OF s`, [rackId]);
  const key = (l: number, s: number) => `${l}:${s}`;
  const have = new Map(existing.map((s) => [key(s.level_no, s.slot_no), s]));
  const wanted = new Set<string>();

  layout.levels.forEach((lv, i) => {
    for (let s = 1; s <= lv.slots; s++) wanted.add(key(i + 1, s));
  });
  for (const lv of layout.levels) if (lv.rule) await assertRule(c, lv.rule);

  // 1) Quitar lo que sobra (solo si está vacío).
  for (const s of existing) {
    if (wanted.has(key(s.level_no, s.slot_no))) continue;
    if (s.occupied > 0) throw conflict('slots_not_empty', { slot: s.code });
    await c.db.query('DELETE FROM slots WHERE id = $1', [s.id]);
  }
  // 2) Crear o actualizar capacidad.
  for (let i = 0; i < layout.levels.length; i++) {
    const lv = layout.levels[i];
    for (let s = 1; s <= lv.slots; s++) {
      const cur = have.get(key(i + 1, s));
      if (cur) {
        if (cur.capacity !== lv.capacity) {
          if (lv.capacity < cur.occupied) throw conflict('capacity_below_occupancy', { slot: cur.code, occupied: cur.occupied });
          await c.db.query('UPDATE slots SET capacity = $2 WHERE id = $1', [cur.id, lv.capacity]);
        }
      } else {
        await c.db.query(
          `INSERT INTO slots (company_id, rack_id, level_no, slot_no, code, capacity) VALUES ($1,$2,$3,$4,$5,$6)`,
          [c.companyId, rackId, i + 1, s, `${rack.wh_code}/${rack.area_code}/${rack.code}/${i + 1}-${s}`, lv.capacity]);
      }
    }
  }
  // 3) Reglas por nivel: se quitan las de niveles que ya no existen y se guardan/borran las indicadas.
  await c.db.query('DELETE FROM rack_level_rules WHERE rack_id = $1 AND level_no > $2', [rackId, layout.levels.length]);
  for (let i = 0; i < layout.levels.length; i++) {
    const rule = layout.levels[i].rule;
    if (rule === undefined) continue;
    if (rule === null) { await c.db.query('DELETE FROM rack_level_rules WHERE rack_id = $1 AND level_no = $2', [rackId, i + 1]); continue; }
    await c.db.query(
      `INSERT INTO rack_level_rules (company_id, rack_id, level_no, equipment_type_id, cosmetic_grade_ids, functional_grade_ids, group_by, strict)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (rack_id, level_no) DO UPDATE SET equipment_type_id = EXCLUDED.equipment_type_id, cosmetic_grade_ids = EXCLUDED.cosmetic_grade_ids,
         functional_grade_ids = EXCLUDED.functional_grade_ids, group_by = EXCLUDED.group_by, strict = EXCLUDED.strict`,
      [c.companyId, rackId, i + 1, rule.typeId, [...new Set(rule.cosmeticGradeIds)], [...new Set(rule.functionalGradeIds)], rule.groupBy, rule.strict]);
  }
}

export async function locationRoutes(app: FastifyInstance) {
  // ---------- Árbol completo con ocupación ----------
  app.get('/api/locations/tree', route('locations.view', async (c) => {
    const warehouses = await c.db.rows('SELECT id, code, name, address, is_active AS "isActive" FROM warehouses ORDER BY code');
    const areas = await c.db.rows('SELECT id, warehouse_id AS "warehouseId", code, name, description, is_active AS "isActive" FROM areas ORDER BY code');
    const racks = await c.db.rows('SELECT id, area_id AS "areaId", code, name, notes, is_active AS "isActive" FROM racks ORDER BY code');
    const slots = await c.db.rows(
      `SELECT s.id, s.rack_id AS "rackId", s.level_no AS "levelNo", s.slot_no AS "slotNo", s.code, s.capacity, s.is_active AS "isActive",
              (SELECT count(*) FROM units u WHERE u.slot_id = s.id)::int AS occupied
         FROM slots s ORDER BY s.level_no, s.slot_no`);
    const prefs = await c.db.rows('SELECT area_id AS "areaId", equipment_type_id AS "equipmentTypeId" FROM area_equipment_types');
    const rules = await c.db.rows<any>(
      `SELECT rack_id AS "rackId", level_no AS "levelNo", equipment_type_id AS "typeId", cosmetic_grade_ids AS "cosmeticGradeIds",
              functional_grade_ids AS "functionalGradeIds", group_by AS "groupBy", strict FROM rack_level_rules`);
    const ruleOf = new Map(rules.map((r) => [`${r.rackId}:${r.levelNo}`, { typeId: r.typeId, cosmeticGradeIds: r.cosmeticGradeIds, functionalGradeIds: r.functionalGradeIds, groupBy: r.groupBy, strict: r.strict }]));
    const slotsByRack = new Map<number, any[]>();
    for (const s of slots) (slotsByRack.get(s.rackId) ?? slotsByRack.set(s.rackId, []).get(s.rackId)!).push(s);

    const rackNodes = racks.map((r: any) => {
      const rs = slotsByRack.get(r.id) ?? [];
      const levels = new Map<number, any[]>();
      for (const s of rs) (levels.get(s.levelNo) ?? levels.set(s.levelNo, []).get(s.levelNo)!).push(s);
      return {
        ...r,
        capacity: rs.reduce((a, s) => a + s.capacity, 0),
        occupied: rs.reduce((a, s) => a + s.occupied, 0),
        levels: [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([levelNo, sl]) => ({ levelNo, slots: sl, rule: ruleOf.get(`${r.id}:${levelNo}`) ?? null })),
      };
    });
    const areaNodes = areas.map((a: any) => {
      const rs = rackNodes.filter((r: any) => r.areaId === a.id);
      return {
        ...a,
        preferredTypeIds: prefs.filter((p: any) => p.areaId === a.id).map((p: any) => p.equipmentTypeId),
        capacity: rs.reduce((x: number, r: any) => x + r.capacity, 0),
        occupied: rs.reduce((x: number, r: any) => x + r.occupied, 0),
        racks: rs,
      };
    });
    return {
      warehouses: warehouses.map((w: any) => {
        const as = areaNodes.filter((a: any) => a.warehouseId === w.id);
        return { ...w, capacity: as.reduce((x: number, a: any) => x + a.capacity, 0), occupied: as.reduce((x: number, a: any) => x + a.occupied, 0), areas: as };
      }),
    };
  }));

  // Lista plana para selectores.
  app.get('/api/locations/slots', route('locations.view', async (c) => {
    const q = c.query(z.object({ q: z.string().trim().max(50).optional(), free: z.enum(['1']).optional(), rackId: zId.optional(), areaId: zId.optional() }));
    const p: unknown[] = [];
    const where = ['s.is_active', 'r.is_active', 'a.is_active', 'w.is_active'];
    if (q.q) { p.push(`%${q.q.replace(/[\\%_]/g, (m) => '\\' + m)}%`); where.push(`s.code ILIKE $${p.length}`); }
    if (q.rackId) { p.push(q.rackId); where.push(`s.rack_id = $${p.length}`); }
    if (q.areaId) { p.push(q.areaId); where.push(`a.id = $${p.length}`); }
    const items = await c.db.rows(
      `SELECT * FROM (
         SELECT s.id, s.code, s.capacity, s.level_no AS "levelNo", s.slot_no AS "slotNo", r.id AS "rackId", a.id AS "areaId", w.id AS "warehouseId",
                (SELECT count(*) FROM units u WHERE u.slot_id = s.id)::int AS occupied
           FROM slots s JOIN racks r ON r.id = s.rack_id JOIN areas a ON a.id = r.area_id JOIN warehouses w ON w.id = a.warehouse_id
          WHERE ${where.join(' AND ')}
       ) x ${q.free ? 'WHERE x.occupied < x.capacity' : ''} ORDER BY x.code LIMIT 500`, p);
    return { items };
  }));

  // ---------- Almacenes ----------
  const whBody = z.object({ code, name: z.string().trim().min(1).max(120), address: optText(), isActive: z.boolean().optional() });
  app.post('/api/warehouses', route('locations.manage', async (c) => {
    const b = c.body(whBody);
    await assertLocationLimit(c.db, c.companyId);
    const r = await c.db.one<{ id: number }>('INSERT INTO warehouses (company_id, code, name, address) VALUES ($1,$2,$3,$4) RETURNING id', [c.companyId, b.code, b.name, b.address]);
    await c.audit('warehouse.created', 'warehouse', r.id, { code: b.code });
    return { id: r.id };
  }));
  app.put('/api/warehouses/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(whBody);
    const r = await c.db.query('UPDATE warehouses SET code = $2, name = $3, address = $4, is_active = COALESCE($5, is_active) WHERE id = $1', [id, b.code, b.name, b.address, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await recomputeSlotCodes(c, { warehouseId: id });
    await c.audit('warehouse.updated', 'warehouse', id);
    return { ok: true };
  }));
  app.delete('/api/warehouses/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    if ((await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM areas WHERE warehouse_id = $1', [id])).n) throw conflict('has_children');
    const r = await c.db.query('DELETE FROM warehouses WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound();
    await c.audit('warehouse.deleted', 'warehouse', id);
    return { ok: true };
  }));

  // ---------- Áreas ----------
  const areaBody = z.object({
    warehouseId: zId, code, name: z.string().trim().min(1).max(120), description: optText(),
    preferredTypeIds: z.array(zId).default([]), isActive: z.boolean().optional(),
  });
  async function savePrefs(c: Ctx, areaId: number, ids: number[]) {
    await c.db.query('DELETE FROM area_equipment_types WHERE area_id = $1', [areaId]);
    if (ids.length) {
      const r = await c.db.query(
        `INSERT INTO area_equipment_types (company_id, area_id, equipment_type_id)
         SELECT $1, $2, id FROM equipment_types WHERE id = ANY($3::bigint[])`, [c.companyId, areaId, [...new Set(ids)]]);
      if (r.rowCount !== new Set(ids).size) throw badRequest('invalid_equipment_type');
    }
  }
  app.post('/api/areas', route('locations.manage', async (c) => {
    const b = c.body(areaBody);
    const r = await c.db.one<{ id: number }>('INSERT INTO areas (company_id, warehouse_id, code, name, description) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [c.companyId, b.warehouseId, b.code, b.name, b.description]);
    await savePrefs(c, r.id, b.preferredTypeIds);
    await c.audit('area.created', 'area', r.id, { code: b.code });
    return { id: r.id };
  }));
  app.put('/api/areas/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(areaBody);
    const r = await c.db.query('UPDATE areas SET warehouse_id = $2, code = $3, name = $4, description = $5, is_active = COALESCE($6, is_active) WHERE id = $1',
      [id, b.warehouseId, b.code, b.name, b.description, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await savePrefs(c, id, b.preferredTypeIds);
    await recomputeSlotCodes(c, { areaId: id });
    await c.audit('area.updated', 'area', id);
    return { ok: true };
  }));
  app.delete('/api/areas/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    if ((await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM racks WHERE area_id = $1', [id])).n) throw conflict('has_children');
    const r = await c.db.query('DELETE FROM areas WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound();
    await c.audit('area.deleted', 'area', id);
    return { ok: true };
  }));

  // ---------- Racks (con su diseño de niveles y espacios) ----------
  const rackBody = z.object({
    areaId: zId, code, name: optText(120), notes: optText(), isActive: z.boolean().optional(),
    layout: layoutSchema.optional(),
  });
  app.post('/api/racks', route('locations.manage', async (c) => {
    const b = c.body(rackBody);
    const r = await c.db.one<{ id: number }>('INSERT INTO racks (company_id, area_id, code, name, notes) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [c.companyId, b.areaId, b.code, b.name, b.notes]);
    if (b.layout) await applyLayout(c, r.id, b.layout);
    await c.audit('rack.created', 'rack', r.id, { code: b.code });
    return { id: r.id };
  }));
  app.put('/api/racks/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(rackBody);
    const r = await c.db.query('UPDATE racks SET area_id = $2, code = $3, name = $4, notes = $5, is_active = COALESCE($6, is_active) WHERE id = $1',
      [id, b.areaId, b.code, b.name, b.notes, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    await recomputeSlotCodes(c, { rackId: id });
    if (b.layout) await applyLayout(c, id, b.layout);
    await c.audit('rack.updated', 'rack', id);
    return { ok: true };
  }));
  app.put('/api/racks/:id/layout', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    await applyLayout(c, id, c.body(layoutSchema));
    await c.audit('rack.layout_changed', 'rack', id);
    return { ok: true };
  }));
  app.delete('/api/racks/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const r = await c.db.query('DELETE FROM racks WHERE id = $1', [id]); // cascada a espacios; con equipos dentro → 409
    if (!r.rowCount) throw notFound();
    await c.audit('rack.deleted', 'rack', id);
    return { ok: true };
  }));

  app.patch('/api/slots/:id', route('locations.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({ capacity: z.number().int().min(1).max(100000).optional(), isActive: z.boolean().optional() }));
    const s = await c.db.opt<{ code: string; occupied: number }>('SELECT s.code, (SELECT count(*) FROM units u WHERE u.slot_id = s.id)::int AS occupied FROM slots s WHERE s.id = $1 FOR UPDATE', [id]);
    if (!s) throw notFound();
    if (b.capacity !== undefined && b.capacity < s.occupied) throw conflict('capacity_below_occupancy', { slot: s.code, occupied: s.occupied });
    await c.db.query('UPDATE slots SET capacity = COALESCE($2, capacity), is_active = COALESCE($3, is_active) WHERE id = $1', [id, b.capacity ?? null, b.isActive ?? null]);
    await c.audit('slot.updated', 'slot', id, b);
    return { ok: true };
  }));

  // ---------- Ubicación inteligente ----------
  app.post('/api/locations/suggest', route('locations.assign', async (c) => {
    const { unitIds } = c.body(z.object({ unitIds: z.array(zId).min(1).max(1000) }));
    const units = await loadPlaceable(c.db, unitIds);
    const settings = await getSettings(c.db, c.companyId);
    const items = await suggestPlacement(c.db, units, settings.placement);
    return { items };
  }));

  // ---------- Ubicar / mover / sacar de ubicación ----------
  app.post('/api/locations/assign', route('locations.assign', async (c) => {
    const { assignments } = c.body(z.object({ assignments: z.array(z.object({ unitId: zId, slotId: zId })).min(1).max(1000) }));
    const slotIds = [...new Set(assignments.map((a) => a.slotId))].sort((a, b) => a - b);
    // Bloqueo ordenado: dos personas ubicando en el mismo espacio a la vez no pueden pasarse de capacidad.
    const slots = await c.db.rows<{ id: number; code: string; capacity: number; is_active: boolean }>(
      'SELECT id, code, capacity, is_active FROM slots WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [slotIds]);
    if (slots.length !== slotIds.length) throw badRequest('invalid_slot');
    const unitIds = assignments.map((a) => a.unitId);
    if (new Set(unitIds).size !== unitIds.length) throw badRequest('duplicate_unit');
    await lockRows(c.db, 'units', unitIds);
    const units = await c.db.rows<{ id: number; slot_id: number | null; code: string; status_key: string }>(
      `SELECT u.id, u.slot_id, u.code, st.system_key AS status_key FROM units u JOIN catalog_items st ON st.id = u.status_id
        WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [unitIds]);
    if (units.length !== unitIds.length) throw notFound('unit_not_found');
    for (const u of units) if (u.status_key === 'sold') throw conflict('unit_sold', { code: u.code });

    const occ = await c.db.rows<{ slot_id: number; n: number }>(
      'SELECT slot_id, count(*)::int AS n FROM units WHERE slot_id = ANY($1::bigint[]) AND NOT (id = ANY($2::bigint[])) GROUP BY slot_id', [slotIds, unitIds]);
    const used = new Map(occ.map((o) => [o.slot_id, o.n]));
    const incoming = new Map<number, number>();
    for (const a of assignments) incoming.set(a.slotId, (incoming.get(a.slotId) ?? 0) + 1);
    for (const s of slots) {
      if (!s.is_active) throw conflict('slot_inactive', { slot: s.code });
      const total = (used.get(s.id) ?? 0) + (incoming.get(s.id) ?? 0);
      if (total > s.capacity) throw conflict('slot_full', { slot: s.code, capacity: s.capacity });
    }
    const before = new Map(units.map((u) => [u.id, u.slot_id]));
    // Ubicar a mano siempre se permite, pero se avisa si el equipo no cumple la regla del nivel.
    const rules = await loadSlotRules(c.db, slotIds);
    const placeable = new Map((await loadPlaceable(c.db, unitIds)).map((p) => [p.id, p]));
    const codeOf = new Map(units.map((u) => [u.id, u.code]));
    const slotCodeOf = new Map(slots.map((s) => [s.id, s.code]));
    const warnings: { unit: string; slot: string }[] = [];
    for (const a of assignments) {
      await c.db.query('UPDATE units SET slot_id = $2 WHERE id = $1', [a.unitId, a.slotId]);
      if (before.get(a.unitId) !== a.slotId) await c.audit('unit.moved', 'unit', a.unitId, { from: before.get(a.unitId) ?? null, to: a.slotId });
      const p = placeable.get(a.unitId);
      if (p && !ruleAllows(p, rules.get(a.slotId) ?? null)) warnings.push({ unit: codeOf.get(a.unitId)!, slot: slotCodeOf.get(a.slotId)! });
    }
    return { moved: assignments.length, warnings };
  }));

  app.post('/api/locations/unassign', route('locations.assign', async (c) => {
    const { unitIds } = c.body(z.object({ unitIds: z.array(zId).min(1).max(1000) }));
    const rows = await c.db.rows<{ id: number; slot_id: number }>(
      'SELECT id, slot_id FROM units WHERE id = ANY($1::bigint[]) AND slot_id IS NOT NULL ORDER BY id FOR UPDATE', [unitIds]);
    if (rows.length) await c.db.query('UPDATE units SET slot_id = NULL WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
    for (const r of rows) await c.audit('unit.moved', 'unit', r.id, { from: r.slot_id, to: null });
    return { removed: rows.length };
  }));
}
