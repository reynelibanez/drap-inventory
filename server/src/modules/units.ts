import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam, zPage } from '../http.js';
import { getSettings, nextUnitCode } from '../settings.js';
import { assertCatalogItem, likeEscape, lockRows, sysItemId, sysKeys } from '../services/common.js';
import { loadTypeAttrs, normalizeSpecs, type Specs } from '../services/specs.js';
import { autoPlaceUnit } from '../services/placement.js';
import { inheritUnitCost, maybeAutoApply } from '../services/costs.js';
import { applyPriceRules, autoPriceEnabled } from '../services/prices.js';

const UNIT_SELECT = `
  SELECT u.id, u.code, u.serial_number AS "serialNumber", u.specs, u.notes,
         u.lot_id AS "lotId", l.code AS "lotCode", u.lot_line_id AS "lotLineId",
         u.equipment_type_id AS "equipmentTypeId", u.status_id AS "statusId", st.system_key AS "statusKey",
         u.cosmetic_grade_id AS "cosmeticGradeId", u.functional_grade_id AS "functionalGradeId",
         u.cosmetic_grade_note AS "cosmeticGradeNote", u.functional_grade_note AS "functionalGradeNote",
         u.slot_id AS "slotId", sl.code AS "slotCode", u.tester_number AS "testerNumber",
         u.tested_at AS "testedAt", u.created_at AS "createdAt", u.updated_at AS "updatedAt",
         o.id AS "orderId", o.code AS "orderCode", o.created_by AS "_orderBy", o.seller_membership AS "_orderSeller",
         u.cost, u.cost_source AS "costSource", u.list_price AS "listPrice", u.price_source AS "priceSource",
         COALESCE(pr.n, 0) AS "printCount", pr.last_at AS "lastPrintedAt", lastp.full_name AS "lastPrintedByName"
    FROM units u
    JOIN lots l ON l.id = u.lot_id
    JOIN catalog_items st ON st.id = u.status_id
    LEFT JOIN slots sl ON sl.id = u.slot_id
    LEFT JOIN LATERAL (
      SELECT so.id, so.code, so.created_by, (SELECT se.membership_id FROM sellers se WHERE se.id = so.seller_id) AS seller_membership
        FROM sale_items si JOIN sales_orders so ON so.id = si.order_id
       WHERE si.unit_id = u.id AND si.released_at IS NULL LIMIT 1) o ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n, max(printed_at) AS last_at FROM unit_label_prints ulp WHERE ulp.unit_id = u.id) pr ON true
    LEFT JOIN LATERAL (
      SELECT us.full_name FROM unit_label_prints ulp2 JOIN users us ON us.id = ulp2.printed_by
       WHERE ulp2.unit_id = u.id ORDER BY ulp2.printed_at DESC LIMIT 1) lastp ON true`;

/** Costos solo para quien puede verlos (costs.view) y precios de lista para quien trabaja con precios. */
export function redactUnit<T>(c: Ctx, row: T): T {
  const u = row as Record<string, unknown>;
  if (!c.can('costs.view')) { u.cost = null; u.costSource = null; }
  if (!(c.can('sales.price') || c.can('prices.manage'))) { u.listPrice = null; u.priceSource = null; }
  // El pedido que tiene reservado o vendido el equipo solo se muestra a quien puede ver ese pedido (los ajenos quedan ocultos).
  if (!c.can('sales.view_all') && u.orderId != null && u._orderBy !== c.userId && u._orderSeller !== c.membershipId) { u.orderId = null; u.orderCode = null; }
  delete u._orderBy; delete u._orderSeller;
  return row;
}

export async function loadUnit(c: Ctx, id: number, forUpdate = false) {
  if (forUpdate) await lockRows(c.db, 'units', [id]);
  const u = await c.db.opt<any>(`${UNIT_SELECT} WHERE u.id = $1`, [id]);
  if (!u) throw notFound('unit_not_found');
  return redactUnit(c, u);
}

const cleanSerial = (s: string | null | undefined) => {
  const v = (s ?? '').trim();
  return v === '' ? null : v.slice(0, 100);
};

async function assertSerialFree(c: Ctx, serial: string | null, exceptUnitId?: number) {
  if (!serial) return;
  const dup = await c.db.opt<{ id: number; code: string }>(
    'SELECT id, code FROM units WHERE lower(serial_number) = lower($1) AND id <> $2', [serial, exceptUnitId ?? 0]);
  if (dup) throw conflict('serial_duplicate', { code: dup.code, unitId: dup.id });
}

/** Busca la línea del lote a la que corresponde el equipo (mismo tipo y especificaciones de línea). */
async function matchLine(c: Ctx, lotId: number, typeId: number, specs: Specs): Promise<number | null> {
  const r = await c.db.opt<{ id: number }>(
    `SELECT ll.id FROM lot_lines ll
      WHERE ll.lot_id = $1 AND ll.equipment_type_id = $2 AND $3::jsonb @> ll.specs
      ORDER BY (SELECT count(*) FROM units u WHERE u.lot_line_id = ll.id) < COALESCE(ll.counted_qty, ll.expected_qty) DESC,
               (SELECT count(*) FROM jsonb_object_keys(ll.specs)) DESC, ll.line_no
      LIMIT 1`, [lotId, typeId, JSON.stringify(specs)]);
  return r?.id ?? null;
}

const specsInput = z.record(z.string(), z.unknown());

/**
 * Crea un equipo dentro de un lote. `available: true` lo deja disponible de inmediato (sin pasar por testeo),
 * uso reservado a lotes que no requieren testeo individual (venta de PC suelta o del lote completo, o una
 * importación). Si además se pasan los grados (p. ej. porque la importación ya traía la nota de calidad del
 * equipo), se guardan igual que al terminar un testeo normal: un grado funcional "no vendible" (como F) dejará
 * el equipo en "No vendible" en vez de "Disponible", nunca a la venta por error.
 */
export async function insertUnit(c: Ctx, opts: {
  lotId: number; lotCode: string; lineId: number | null; equipmentTypeId: number; specs: Specs;
  serial: string | null; notes?: string | null; available: boolean;
  cosmeticGradeId?: number | null; functionalGradeId?: number | null;
}): Promise<{ id: number; code: string }> {
  const settings = await getSettings(c.db, c.companyId);
  const { code, seq } = await nextUnitCode(c.db, settings, opts.lotCode, c.techNumber);
  let statusKey: 'available' | 'testing' | 'not_sellable' = opts.available ? 'available' : 'testing';
  if (opts.available && opts.functionalGradeId != null) {
    const fun = await c.db.opt<{ meta: { sellable?: boolean } | null }>('SELECT meta FROM catalog_items WHERE id = $1', [opts.functionalGradeId]);
    if (fun?.meta?.sellable === false) statusKey = 'not_sellable';
  }
  const status = await sysItemId(c.db, 'unit_status', statusKey);
  const u = await c.db.one<{ id: number }>(
    `INSERT INTO units (company_id, code, lot_id, lot_line_id, equipment_type_id, tester_membership_id, tester_number, tester_seq,
                        serial_number, specs, status_id, notes, tested_at, cosmetic_grade_id, functional_grade_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [c.companyId, code, opts.lotId, opts.lineId, opts.equipmentTypeId, c.membershipId, c.techNumber, seq,
      opts.serial, JSON.stringify(opts.specs), status, opts.notes ?? null, opts.available ? new Date() : null,
      opts.cosmeticGradeId ?? null, opts.functionalGradeId ?? null]);
  await inheritUnitCost(c.db, u.id);
  return { id: u.id, code };
}

export async function unitRoutes(app: FastifyInstance) {
  // ---------- Listado con filtros ----------
  app.get('/api/units', route('units.view', async (c) => {
    const q = c.query(zPage.extend({
      lotId: zId.optional(), typeId: zId.optional(), statusId: zId.optional(),
      statusKey: z.string().max(40).optional(),
      notStatusKey: z.string().max(40).optional(),   // todos menos este estado (p. ej. "testing" → ya testeados)
      testerNumber: zId.optional(),
      cosmeticGradeId: zId.optional(), functionalGradeId: zId.optional(),
      slotId: zId.optional(), placed: z.enum(['yes', 'no']).optional(),
      specs: z.string().max(2000).optional(),      // JSON: {"brand": 12, "ram": 34}
      ids: z.string().max(3000).optional(),        // "1,2,3"
      sort: z.enum(['newest', 'oldest', 'code']).default('newest'),
    }));
    const p: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.q) {
      p.push(`%${likeEscape(q.q)}%`);
      where.push(`(u.code ILIKE $${p.length} OR u.serial_number ILIKE $${p.length})`);
    }
    if (q.lotId) add('u.lot_id = ?', q.lotId);
    if (q.typeId) add('u.equipment_type_id = ?', q.typeId);
    if (q.statusId) add('u.status_id = ?', q.statusId);
    if (q.statusKey) add('st.system_key = ?', q.statusKey);
    if (q.notStatusKey) add('st.system_key IS DISTINCT FROM ?', q.notStatusKey);
    if (q.testerNumber) add('u.tester_number = ?', q.testerNumber);
    if (q.cosmeticGradeId) add('u.cosmetic_grade_id = ?', q.cosmeticGradeId);
    if (q.functionalGradeId) add('u.functional_grade_id = ?', q.functionalGradeId);
    if (q.slotId) add('u.slot_id = ?', q.slotId);
    if (q.placed === 'yes') where.push('u.slot_id IS NOT NULL');
    if (q.placed === 'no') where.push('u.slot_id IS NULL');
    if (q.ids) add('u.id = ANY(?::bigint[])', q.ids.split(',').map(Number).filter(Number.isInteger));
    if (q.specs) {
      let obj: unknown;
      try { obj = JSON.parse(q.specs); } catch { throw badRequest('invalid_value'); }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw badRequest('invalid_value');
      add('u.specs @> ?::jsonb', JSON.stringify(obj));
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = q.sort === 'oldest' ? 'u.id ASC' : q.sort === 'code' ? 'u.code ASC' : 'u.id DESC';
    const total = (await c.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM units u JOIN catalog_items st ON st.id = u.status_id ${w}`, p)).n;
    const items = (await c.db.rows(`${UNIT_SELECT} ${w} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p)).map((u) => redactUnit(c, u));
    return { items, total };
  }));

  // Varios equipos por id (para imprimir etiquetas): /api/units/batch?ids=1,2,3
  app.get('/api/units/batch', route('units.view', async (c) => {
    const { ids } = c.query(z.object({ ids: z.string().min(1).max(6000) }));
    const list = [...new Set(ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    const items = list.length ? (await c.db.rows<any>(`${UNIT_SELECT} WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [list])).map((u) => redactUnit(c, u)) : [];
    return { items };
  }));

  // Registro de que se mandó a imprimir la etiqueta de estos equipos (quién y cuándo). Un registro por
  // equipo por cada vez que se imprime (no por cada copia): así "printCount" refleja cuántas veces se
  // mandó a imprimir, sea desde Testeo, Inventario, el detalle de un lote o el de un equipo.
  app.post('/api/units/print-log', route('units.view', async (c) => {
    const { unitIds } = c.body(z.object({ unitIds: z.array(zId).min(1).max(500) }));
    const ids = [...new Set(unitIds)];
    const valid = (await c.db.rows<{ id: number }>('SELECT id FROM units WHERE id = ANY($1::bigint[])', [ids])).map((r) => r.id);
    if (valid.length) {
      await c.db.query(
        `INSERT INTO unit_label_prints (company_id, unit_id, printed_by) SELECT $1, x, $2 FROM unnest($3::bigint[]) AS x`,
        [c.companyId, c.userId, valid]);
    }
    return { ok: true, logged: valid.length };
  }));

  // Sugerencias de notas: valores ya usados antes en ese mismo campo (notas generales,
  // nota de grado cosmético o nota de grado funcional), para no volver a escribir lo mismo.
  const NOTE_SUGGESTION_COLUMNS = {
    notes: 'notes',
    cosmeticGradeNote: 'cosmetic_grade_note',
    functionalGradeNote: 'functional_grade_note',
  } as const;
  app.get('/api/units/note-suggestions', route('units.view', async (c) => {
    const { field } = c.query(z.object({ field: z.enum(['notes', 'cosmeticGradeNote', 'functionalGradeNote']) }));
    const column = NOTE_SUGGESTION_COLUMNS[field];
    const rows = await c.db.rows<{ value: string }>(
      `SELECT ${column} AS value FROM (
         SELECT DISTINCT ON (${column}) ${column}, max(updated_at) OVER (PARTITION BY ${column}) AS last_used
         FROM units
         WHERE ${column} IS NOT NULL AND btrim(${column}) <> ''
       ) x ORDER BY last_used DESC LIMIT 50`);
    return { suggestions: rows.map((r) => r.value) };
  }));

  // Escaneo / búsqueda exacta: código completo, forma corta (1t120) o número de serie.
  app.get('/api/units/lookup', route('units.view', async (c) => {
    const { code } = c.query(z.object({ code: z.string().trim().min(1).max(100) }));
    const u = await c.db.opt<{ id: number }>(
      `SELECT id FROM units
        WHERE lower(code) = lower($1) OR lower(serial_number) = lower($1)
           OR lower(code) LIKE '%-' || lower($2)
        ORDER BY (lower(code) = lower($1)) DESC LIMIT 1`, [code, likeEscape(code)]);
    if (!u) throw notFound('unit_not_found');
    return { id: u.id };
  }));

  app.get('/api/units/:id', route('units.view', async (c) => {
    const { id } = c.params(zIdParam);
    const unit = await loadUnit(c, id);
    const history = await c.db.rows(
      `SELECT a.id, a.at, a.action, a.data, u.full_name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity = 'unit' AND a.entity_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 200`, [id]);
    return { ...unit, history };
  }));

  // ---------- Registrar un equipo para testeo ----------
  app.post('/api/lots/:id/units', route('units.test', async (c) => {
    const { id: lotId } = c.params(zIdParam);
    const b = c.body(z.object({
      equipmentTypeId: zId,
      lotLineId: zId.nullish(),
      serialNumber: z.string().max(100).nullish(),
      specs: specsInput.default({}),
      notes: z.string().trim().max(1000).nullish(),
      // Solo válido en un lote marcado como "no requiere testeo individual": deja el equipo disponible de una vez, sin testeo ni grados.
      skipTest: z.boolean().default(false),
    }));
    await lockRows(c.db, 'lots', [lotId]);
    const lot = await c.db.opt<{ id: number; code: string; status_key: string; requires_testing: boolean }>(
      `SELECT l.id, l.code, l.requires_testing, ci.system_key AS status_key FROM lots l JOIN catalog_items ci ON ci.id = l.status_id WHERE l.id = $1`, [lotId]);
    if (!lot) throw notFound('lot_not_found');
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    if (lot.status_key === 'open' || lot.status_key === 'counting') throw conflict('lot_not_counted');
    if (b.skipTest && lot.requires_testing) throw conflict('lot_requires_testing');

    const type = await c.db.opt<{ tracks_serial: boolean; is_active: boolean }>('SELECT tracks_serial, is_active FROM equipment_types WHERE id = $1', [b.equipmentTypeId]);
    if (!type || !type.is_active) throw badRequest('invalid_equipment_type');
    const attrs = await loadTypeAttrs(c.db, b.equipmentTypeId);
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'draft', { attrs });

    let lineId = b.lotLineId ?? null;
    if (lineId) {
      const line = await c.db.opt<{ equipment_type_id: number }>('SELECT equipment_type_id FROM lot_lines WHERE id = $1 AND lot_id = $2', [lineId, lotId]);
      if (!line || line.equipment_type_id !== b.equipmentTypeId) throw badRequest('invalid_line');
    } else {
      lineId = await matchLine(c, lotId, b.equipmentTypeId, specs);
    }

    const serial = cleanSerial(b.serialNumber);
    await assertSerialFree(c, serial);

    const { id: unitId, code: unitCode } = await insertUnit(c, {
      lotId, lotCode: lot.code, lineId, equipmentTypeId: b.equipmentTypeId, specs, serial, notes: b.notes, available: b.skipTest,
    });

    if (!b.skipTest && lot.status_key === 'counted') {
      await c.db.query('UPDATE lots SET status_id = $2 WHERE id = $1', [lotId, await sysItemId(c.db, 'lot_status', 'testing')]);
      await c.audit('lot.status_changed', 'lot', lotId, { from: 'counted', to: 'testing', action: 'first_unit' });
    }
    await c.audit('unit.created', 'unit', unitId, { code: unitCode, lotCode: lot.code, skipTest: b.skipTest });
    await maybeAutoApply(c, lotId);
    if (b.skipTest && (await autoPriceEnabled(c.db))) await applyPriceRules(c.db, { unitIds: [unitId], scope: 'unsold' });
    return loadUnit(c, unitId);
  }));

  // ---------- Registro masivo (varios equipos idénticos, sin serie ni datos que cambien de uno a otro) ----------
  app.post('/api/lots/:id/units/batch', route('units.test', async (c) => {
    const { id: lotId } = c.params(zIdParam);
    const b = c.body(z.object({
      equipmentTypeId: zId,
      lotLineId: zId.nullish(),
      specs: specsInput.default({}),
      quantity: z.number().int().min(1).max(500),
      notes: z.string().trim().max(1000).nullish(),
      skipTest: z.boolean().default(false),
    }));
    await lockRows(c.db, 'lots', [lotId]);
    const lot = await c.db.opt<{ id: number; code: string; status_key: string; requires_testing: boolean }>(
      `SELECT l.id, l.code, l.requires_testing, ci.system_key AS status_key FROM lots l JOIN catalog_items ci ON ci.id = l.status_id WHERE l.id = $1`, [lotId]);
    if (!lot) throw notFound('lot_not_found');
    if (lot.status_key === 'closed') throw conflict('lot_closed');
    if (lot.status_key === 'open' || lot.status_key === 'counting') throw conflict('lot_not_counted');
    if (b.skipTest && lot.requires_testing) throw conflict('lot_requires_testing');

    const type = await c.db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [b.equipmentTypeId]);
    if (!type || !type.is_active) throw badRequest('invalid_equipment_type');
    const attrs = await loadTypeAttrs(c.db, b.equipmentTypeId);
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'draft', { attrs });

    let lineId = b.lotLineId ?? null;
    if (lineId) {
      const line = await c.db.opt<{ equipment_type_id: number }>('SELECT equipment_type_id FROM lot_lines WHERE id = $1 AND lot_id = $2', [lineId, lotId]);
      if (!line || line.equipment_type_id !== b.equipmentTypeId) throw badRequest('invalid_line');
    } else {
      lineId = await matchLine(c, lotId, b.equipmentTypeId, specs);
    }

    // Sin número de serie: son equipos iguales entre sí, solo cambia la cantidad.
    const created: { id: number; code: string }[] = [];
    for (let i = 0; i < b.quantity; i++) {
      created.push(await insertUnit(c, { lotId, lotCode: lot.code, lineId, equipmentTypeId: b.equipmentTypeId, specs, serial: null, notes: b.notes, available: b.skipTest }));
    }

    if (!b.skipTest && lot.status_key === 'counted') {
      await c.db.query('UPDATE lots SET status_id = $2 WHERE id = $1', [lotId, await sysItemId(c.db, 'lot_status', 'testing')]);
      await c.audit('lot.status_changed', 'lot', lotId, { from: 'counted', to: 'testing', action: 'first_unit' });
    }
    await c.audit('unit.batch_created', 'unit', lotId, { lotCode: lot.code, equipmentTypeId: b.equipmentTypeId, quantity: b.quantity, skipTest: b.skipTest });
    await maybeAutoApply(c, lotId);
    if (b.skipTest && (await autoPriceEnabled(c.db))) await applyPriceRules(c.db, { unitIds: created.map((u) => u.id), scope: 'unsold' });
    // Se devuelven los equipos completos (no solo id/código) para que la pantalla los trate igual que un registro uno a uno.
    const items = await c.db.rows<any>(`${UNIT_SELECT} WHERE u.id = ANY($1::bigint[]) ORDER BY u.id`, [created.map((u) => u.id)]);
    return { units: items.map((u) => redactUnit(c, u)) };
  }));

  // ---------- Editar datos ----------
  app.patch('/api/units/:id', route('units.edit', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      serialNumber: z.string().max(100).nullable().optional(),
      specs: specsInput.optional(),
      cosmeticGradeId: zId.nullable().optional(),
      functionalGradeId: zId.nullable().optional(),
      cosmeticGradeNote: z.string().trim().max(1000).nullable().optional(),
      functionalGradeNote: z.string().trim().max(1000).nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }));
    const unit = await loadUnit(c, id, true);
    if (unit.statusKey === 'sold') throw conflict('unit_sold');
    const changes: Record<string, unknown> = {};

    let specs: Specs | undefined;
    if (b.specs) {
      // Se combinan con los existentes; un valor vacío/nulo borra el dato.
      const merged: Record<string, unknown> = { ...unit.specs };
      for (const [k, v] of Object.entries(b.specs)) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
      specs = await normalizeSpecs(c.db, unit.equipmentTypeId, merged, 'draft');
      // Constancia de qué datos cambiaron (antes → después), útil cuando se modifica un equipo ya testeado.
      const diff: Record<string, [unknown, unknown]> = {};
      for (const k of new Set([...Object.keys(unit.specs ?? {}), ...Object.keys(specs)])) {
        const a = (unit.specs as Record<string, unknown>)?.[k], b2 = (specs as Record<string, unknown>)[k];
        if (JSON.stringify(a) !== JSON.stringify(b2)) diff[k] = [a ?? null, b2 ?? null];
      }
      changes.specs = Object.keys(diff).length ? diff : true;
    }
    const cos = b.cosmeticGradeId !== undefined ? await assertCatalogItem(c.db, b.cosmeticGradeId, 'cosmetic_grade', 'cosmeticGradeId') : undefined;
    const fun = b.functionalGradeId !== undefined ? await assertCatalogItem(c.db, b.functionalGradeId, 'functional_grade', 'functionalGradeId') : undefined;
    const serial = b.serialNumber !== undefined ? cleanSerial(b.serialNumber) : undefined;
    if (serial !== undefined) { await assertSerialFree(c, serial, id); changes.serial = serial; }
    if (b.cosmeticGradeId !== undefined) changes.cosmeticGradeId = b.cosmeticGradeId;
    if (b.functionalGradeId !== undefined) changes.functionalGradeId = b.functionalGradeId;
    if (b.cosmeticGradeNote !== undefined) changes.cosmeticGradeNote = b.cosmeticGradeNote;
    if (b.functionalGradeNote !== undefined) changes.functionalGradeNote = b.functionalGradeNote;

    await c.db.query(
      `UPDATE units SET specs = COALESCE($2::jsonb, specs),
              serial_number = CASE WHEN $3::boolean THEN $4 ELSE serial_number END,
              cosmetic_grade_id = CASE WHEN $5::boolean THEN $6::bigint ELSE cosmetic_grade_id END,
              functional_grade_id = CASE WHEN $7::boolean THEN $8::bigint ELSE functional_grade_id END,
              notes = CASE WHEN $9::boolean THEN $10 ELSE notes END,
              cosmetic_grade_note = CASE WHEN $11::boolean THEN $12 ELSE cosmetic_grade_note END,
              functional_grade_note = CASE WHEN $13::boolean THEN $14 ELSE functional_grade_note END
        WHERE id = $1`,
      [id, specs ? JSON.stringify(specs) : null, serial !== undefined, serial ?? null,
        cos !== undefined, cos?.id ?? null, fun !== undefined, fun?.id ?? null, b.notes !== undefined, b.notes ?? null,
        b.cosmeticGradeNote !== undefined, b.cosmeticGradeNote ?? null, b.functionalGradeNote !== undefined, b.functionalGradeNote ?? null]);

    // Si un equipo disponible pasa a un grado funcional "no vendible", deja de estar disponible.
    if (fun && fun.meta?.sellable === false && unit.statusKey === 'available') {
      await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1', [id, await sysItemId(c.db, 'unit_status', 'not_sellable')]);
      changes.status = 'not_sellable';
    }
    await c.audit('unit.updated', 'unit', id, changes);
    if (await autoPriceEnabled(c.db)) await applyPriceRules(c.db, { unitIds: [id], scope: 'unsold' });
    return loadUnit(c, id);
  }));

  // ---------- Editar los mismos datos en varios equipos a la vez ----------
  // Igual que editar uno solo, pero aplicado a todos los seleccionados: cada campo que se incluya se cambia igual
  // en todos (los que no se incluyen quedan como estaban en cada equipo). Si alguno ya está vendido, no se cambia
  // nada (ni en ese ni en los demás): hay que sacarlo de la selección primero.
  app.post('/api/units/bulk-edit', route('units.edit', async (c) => {
    const b = c.body(z.object({
      unitIds: z.array(zId).min(1).max(5000),
      specs: specsInput.optional(),
      cosmeticGradeId: zId.nullable().optional(),
      functionalGradeId: zId.nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }));
    if (!b.specs && b.cosmeticGradeId === undefined && b.functionalGradeId === undefined && b.notes === undefined) throw badRequest('nothing_to_change');

    const ids = [...new Set(b.unitIds)].sort((x, y) => x - y);
    await lockRows(c.db, 'units', ids);
    const units = await c.db.rows<{ id: number; code: string; status_key: string; equipment_type_id: number; specs: Specs }>(
      `SELECT u.id, u.code, st.system_key AS status_key, u.equipment_type_id, u.specs
         FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.id = ANY($1::bigint[])`, [ids]);
    if (units.length !== ids.length) throw notFound('unit_not_found');
    const sold = units.find((u) => u.status_key === 'sold');
    if (sold) throw conflict('unit_sold', { code: sold.code });

    const cos = b.cosmeticGradeId !== undefined ? await assertCatalogItem(c.db, b.cosmeticGradeId, 'cosmetic_grade', 'cosmeticGradeId') : undefined;
    const fun = b.functionalGradeId !== undefined ? await assertCatalogItem(c.db, b.functionalGradeId, 'functional_grade', 'functionalGradeId') : undefined;

    for (const u of units) {
      const changes: Record<string, unknown> = {};
      let specs: Specs | undefined;
      if (b.specs) {
        // Se combinan con los datos propios de CADA equipo (no se pisa el resto): un valor vacío/nulo borra ese dato.
        const merged: Record<string, unknown> = { ...u.specs };
        for (const [k, v] of Object.entries(b.specs)) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
        specs = await normalizeSpecs(c.db, u.equipment_type_id, merged, 'draft');
        const diff: Record<string, [unknown, unknown]> = {};
        for (const k of new Set([...Object.keys(u.specs ?? {}), ...Object.keys(specs)])) {
          const a = (u.specs as Record<string, unknown>)?.[k], b2 = (specs as Record<string, unknown>)[k];
          if (JSON.stringify(a) !== JSON.stringify(b2)) diff[k] = [a ?? null, b2 ?? null];
        }
        changes.specs = Object.keys(diff).length ? diff : true;
      }
      if (b.cosmeticGradeId !== undefined) changes.cosmeticGradeId = b.cosmeticGradeId;
      if (b.functionalGradeId !== undefined) changes.functionalGradeId = b.functionalGradeId;

      await c.db.query(
        `UPDATE units SET specs = COALESCE($2::jsonb, specs),
                cosmetic_grade_id = CASE WHEN $3::boolean THEN $4::bigint ELSE cosmetic_grade_id END,
                functional_grade_id = CASE WHEN $5::boolean THEN $6::bigint ELSE functional_grade_id END,
                notes = CASE WHEN $7::boolean THEN $8 ELSE notes END
          WHERE id = $1`,
        [u.id, specs ? JSON.stringify(specs) : null, cos !== undefined, cos?.id ?? null, fun !== undefined, fun?.id ?? null, b.notes !== undefined, b.notes ?? null]);

      // Si un equipo disponible pasa a un grado funcional "no vendible", deja de estar disponible.
      if (fun && fun.meta?.sellable === false && u.status_key === 'available') {
        await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1', [u.id, await sysItemId(c.db, 'unit_status', 'not_sellable')]);
        changes.status = 'not_sellable';
      }
      await c.audit('unit.updated', 'unit', u.id, changes);
    }
    if (await autoPriceEnabled(c.db)) await applyPriceRules(c.db, { unitIds: ids, scope: 'unsold' });
    return { count: units.length };
  }));

  // ---------- Terminar el testeo ----------
  app.post('/api/units/:id/finish-test', route('units.test', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      cosmeticGradeId: zId,
      functionalGradeId: zId,
      cosmeticGradeNote: z.string().trim().max(1000).nullish(),
      functionalGradeNote: z.string().trim().max(1000).nullish(),
      serialNumber: z.string().max(100).nullish(),
      specs: specsInput.optional(),
      notes: z.string().trim().max(1000).nullish(),
    }));
    const unit = await loadUnit(c, id, true);
    if (!['testing', 'available', 'not_sellable'].includes(unit.statusKey)) throw conflict('unit_not_editable', { status: unit.statusKey });

    const type = await c.db.one<{ tracks_serial: boolean }>('SELECT tracks_serial FROM equipment_types WHERE id = $1', [unit.equipmentTypeId]);
    const merged: Record<string, unknown> = { ...unit.specs };
    for (const [k, v] of Object.entries(b.specs ?? {})) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
    const specs = await normalizeSpecs(c.db, unit.equipmentTypeId, merged, 'test');

    const serial = b.serialNumber !== undefined ? cleanSerial(b.serialNumber) : unit.serialNumber;
    if (type.tracks_serial && !serial) throw badRequest('serial_required');
    await assertSerialFree(c, serial, id);

    await assertCatalogItem(c.db, b.cosmeticGradeId, 'cosmetic_grade', 'cosmeticGradeId');
    const fun = await assertCatalogItem(c.db, b.functionalGradeId, 'functional_grade', 'functionalGradeId');
    const sellable = fun?.meta?.sellable !== false;
    const statusKey = sellable ? 'available' : 'not_sellable';
    const statusId = await sysItemId(c.db, 'unit_status', statusKey);

    await c.db.query(
      `UPDATE units SET specs = $2, serial_number = $3, cosmetic_grade_id = $4, functional_grade_id = $5,
              notes = CASE WHEN $6::boolean THEN $7 ELSE notes END, status_id = $8, tested_at = now(),
              cosmetic_grade_note = $9, functional_grade_note = $10
        WHERE id = $1`,
      [id, JSON.stringify(specs), serial, b.cosmeticGradeId, b.functionalGradeId, b.notes !== undefined, b.notes ?? null, statusId,
        b.cosmeticGradeNote ?? null, b.functionalGradeNote ?? null]);
    await c.audit('unit.tested', 'unit', id, { cosmeticGradeId: b.cosmeticGradeId, functionalGradeId: b.functionalGradeId, status: statusKey });
    // Precio de lista según las reglas (si están activadas y el equipo no tiene un precio fijado a mano).
    if (await autoPriceEnabled(c.db)) await applyPriceRules(c.db, { unitIds: [id], scope: 'unsold' });

    // Ubicación automática: el equipo queda en el espacio que le corresponde según las reglas de los niveles.
    // Si no hay lugar o algo falla, el testeo NO se pierde: solo queda sin ubicar.
    let autoPlaced: { slotCode: string; moved: boolean } | null = null;
    const settings = await getSettings(c.db, c.companyId);
    if (settings.autoPlaceOnTest) {
      await c.db.query('SAVEPOINT auto_place');
      try {
        autoPlaced = await autoPlaceUnit(c.db, id, settings.placement, c.audit);
        await c.db.query('RELEASE SAVEPOINT auto_place');
      } catch (e) {
        await c.db.query('ROLLBACK TO SAVEPOINT auto_place');
        c.req.log.warn({ err: e, unitId: id }, 'auto placement failed');
      }
    }
    return { ...(await loadUnit(c, id)), autoPlaced };
  }));

  // ---------- Eliminar un equipo ----------
  // Un borrador (en testeo, sin terminar) lo elimina quien testea. Un equipo ya testeado puede eliminarse mientras NO se haya
  // vendido (p. ej. se registró por error o se desarmó): quien puede editar equipos. Si estaba reservado, sale del pedido.
  app.delete('/api/units/:id', route(['units.test', 'units.edit'], async (c) => {
    const { id } = c.params(zIdParam);
    const unit = await loadUnit(c, id, true);
    if (unit.statusKey === 'sold') throw conflict('unit_sold', { code: unit.code });
    const draft = unit.statusKey === 'testing' && !unit.testedAt;
    c.need(draft ? 'units.test' : 'units.edit');
    const order = await c.db.opt<{ code: string }>(
      `SELECT o.code FROM sale_items si JOIN sales_orders o ON o.id = si.order_id WHERE si.unit_id = $1 AND si.released_at IS NULL`, [id]);
    // El historial de reservas (ya liberadas o la activa) se elimina junto con el equipo; queda constancia en el historial general.
    await c.db.query('DELETE FROM sale_items WHERE unit_id = $1', [id]);
    await c.db.query('DELETE FROM units WHERE id = $1', [id]);
    await c.audit(draft ? 'unit.draft_deleted' : 'unit.deleted', 'unit', id,
      { code: unit.code, lotCode: unit.lotCode, serialNumber: unit.serialNumber, status: unit.statusKey, orderCode: order?.code ?? null });
    await maybeAutoApply(c, unit.lotId);
    return { ok: true };
  }));

  // ---------- Cambio manual de estado (no aplica a reservado/vendido: los maneja Ventas) ----------
  app.post('/api/units/:id/status', route('units.change_status', async (c) => {
    const { id } = c.params(zIdParam);
    const { statusId, note } = c.body(z.object({ statusId: zId, note: z.string().trim().max(300).nullish() }));
    const unit = await loadUnit(c, id, true);
    if (unit.statusKey === 'reserved' || unit.statusKey === 'sold') throw conflict('status_managed_by_sales');
    const keys = await sysKeys(c.db, 'unit_status');
    const target = await c.db.opt<{ id: number; system_key: string | null }>(
      `SELECT ci.id, ci.system_key FROM catalog_items ci JOIN catalogs ca ON ca.id = ci.catalog_id WHERE ci.id = $1 AND ca.key = 'unit_status' AND ci.is_active`, [statusId]);
    if (!target) throw badRequest('invalid_catalog_value', { field: 'statusId' });
    const tk = keys.get(target.id);
    if (tk === 'reserved' || tk === 'sold') throw conflict('status_managed_by_sales');
    if (tk === 'available' && !unit.testedAt) throw conflict('unit_not_tested');
    await c.db.query('UPDATE units SET status_id = $2 WHERE id = $1', [id, target.id]);
    await c.audit('unit.status_changed', 'unit', id, { from: unit.statusId, to: target.id, note: note ?? null });
    return loadUnit(c, id);
  }));
}
