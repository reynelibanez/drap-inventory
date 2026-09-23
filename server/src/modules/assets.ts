import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../http.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { route, zId, zIdParam, zPage } from '../http.js';
import { getSettings, nextAssetCode } from '../settings.js';
import { assertCatalogItem, likeEscape, sysItemId } from '../services/common.js';
import { loadTypeAttrs, normalizeSpecs } from '../services/specs.js';

/**
 * Activos de la empresa: herramientas y equipos propios (no se venden). Usan los mismos tipos de equipo y atributos
 * que el inventario, pero sin lote, testeo, ubicación en almacén ni pedidos.
 */

const ASSET_SELECT = `
  SELECT a.id, a.code, a.name, a.serial_number AS "serialNumber", a.specs, a.notes,
         a.equipment_type_id AS "equipmentTypeId", a.status_id AS "statusId", st.system_key AS "statusKey",
         a.assigned_to AS "assignedTo", a.location, a.acquired_at AS "acquiredAt",
         a.created_at AS "createdAt", a.updated_at AS "updatedAt", u.full_name AS "createdByName"
    FROM assets a
    JOIN catalog_items st ON st.id = a.status_id
    LEFT JOIN users u ON u.id = a.created_by`;

async function loadAsset(c: Ctx, id: number, forUpdate = false) {
  if (forUpdate) await c.db.query('SELECT id FROM assets WHERE id = $1 FOR UPDATE', [id]);
  const a = await c.db.opt<any>(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
  if (!a) throw notFound('asset_not_found');
  return a;
}

const clean = (s: string | null | undefined, max: number) => {
  const v = (s ?? '').trim();
  return v === '' ? null : v.slice(0, max);
};

async function assertSerialFree(c: Ctx, serial: string | null, exceptId?: number) {
  if (!serial) return;
  const dup = await c.db.opt<{ id: number; code: string }>(
    'SELECT id, code FROM assets WHERE lower(serial_number) = lower($1) AND id <> $2', [serial, exceptId ?? 0]);
  if (dup) throw conflict('asset_serial_duplicate', { code: dup.code, assetId: dup.id });
}

const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'invalid_date');
const specsInput = z.record(z.string(), z.unknown());

export async function assetRoutes(app: FastifyInstance) {
  // ---------- Listado con filtros ----------
  app.get('/api/assets', route('assets.view', async (c) => {
    const q = c.query(zPage.extend({
      typeId: zId.optional(), statusId: zId.optional(),
      statusKey: z.string().max(40).optional(),
      notStatusKey: z.string().max(40).optional(),
      specs: z.string().max(2000).optional(),
      ids: z.string().max(3000).optional(),
      sort: z.enum(['newest', 'oldest', 'code']).default('newest'),
    }));
    const p: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.q) {
      p.push(`%${likeEscape(q.q)}%`);
      const n = p.length;
      where.push(`(a.code ILIKE $${n} OR a.name ILIKE $${n} OR a.serial_number ILIKE $${n} OR a.assigned_to ILIKE $${n} OR a.location ILIKE $${n})`);
    }
    if (q.typeId) add('a.equipment_type_id = ?', q.typeId);
    if (q.statusId) add('a.status_id = ?', q.statusId);
    if (q.statusKey) add('st.system_key = ?', q.statusKey);
    if (q.notStatusKey) add('st.system_key IS DISTINCT FROM ?', q.notStatusKey);
    if (q.ids) add('a.id = ANY(?::bigint[])', q.ids.split(',').map(Number).filter(Number.isInteger));
    if (q.specs) {
      let obj: unknown;
      try { obj = JSON.parse(q.specs); } catch { throw badRequest('invalid_value'); }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw badRequest('invalid_value');
      add('a.specs @> ?::jsonb', JSON.stringify(obj));
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const order = q.sort === 'oldest' ? 'a.id ASC' : q.sort === 'code' ? 'a.code ASC' : 'a.id DESC';
    const total = (await c.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM assets a JOIN catalog_items st ON st.id = a.status_id ${w}`, p)).n;
    const items = await c.db.rows(`${ASSET_SELECT} ${w} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { items, total };
  }));

  // Varios activos por id (para imprimir etiquetas): /api/assets/batch?ids=1,2,3
  app.get('/api/assets/batch', route('assets.view', async (c) => {
    const { ids } = c.query(z.object({ ids: z.string().min(1).max(6000) }));
    const list = [...new Set(ids.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 500);
    const items = list.length ? await c.db.rows<any>(`${ASSET_SELECT} WHERE a.id = ANY($1::bigint[]) ORDER BY a.id`, [list]) : [];
    return { items };
  }));

  // Escaneo / búsqueda exacta por código o número de serie.
  app.get('/api/assets/lookup', route('assets.view', async (c) => {
    const { code } = c.query(z.object({ code: z.string().trim().min(1).max(100) }));
    const a = await c.db.opt<{ id: number }>(
      `SELECT id FROM assets WHERE lower(code) = lower($1) OR lower(serial_number) = lower($1)
        ORDER BY (lower(code) = lower($1)) DESC LIMIT 1`, [code]);
    if (!a) throw notFound('asset_not_found');
    return { id: a.id };
  }));

  app.get('/api/assets/:id', route('assets.view', async (c) => {
    const { id } = c.params(zIdParam);
    const asset = await loadAsset(c, id);
    const history = await c.db.rows(
      `SELECT a.id, a.at, a.action, a.data, u.full_name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.entity = 'asset' AND a.entity_id = $1 ORDER BY a.at DESC, a.id DESC LIMIT 200`, [id]);
    return { ...asset, history };
  }));

  // ---------- Registrar (uno o varios iguales) ----------
  app.post('/api/assets', route('assets.manage', async (c) => {
    const b = c.body(z.object({
      equipmentTypeId: zId,
      name: z.string().max(150).nullish(),
      serialNumber: z.string().max(100).nullish(),
      specs: specsInput.default({}),
      statusId: zId.nullish(),
      assignedTo: z.string().max(150).nullish(),
      location: z.string().max(150).nullish(),
      acquiredAt: zDate.nullish(),
      notes: z.string().trim().max(1000).nullish(),
      /** Cuántos iguales registrar (cada uno con su código). Con número de serie solo se puede registrar uno. */
      quantity: z.coerce.number().int().min(1).max(200).default(1),
    }));
    const type = await c.db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [b.equipmentTypeId]);
    if (!type || !type.is_active) throw badRequest('invalid_equipment_type');
    const attrs = await loadTypeAttrs(c.db, b.equipmentTypeId);
    const specs = await normalizeSpecs(c.db, b.equipmentTypeId, b.specs, 'draft', { attrs });
    const serial = clean(b.serialNumber, 100);
    if (serial && b.quantity > 1) throw badRequest('asset_serial_single');
    await assertSerialFree(c, serial);
    const status = b.statusId ? (await assertCatalogItem(c.db, b.statusId, 'asset_status', 'statusId'))!.id : await sysItemId(c.db, 'asset_status', 'in_use');
    const settings = await getSettings(c.db, c.companyId);

    const ids: number[] = [];
    for (let i = 0; i < b.quantity; i++) {
      const code = await nextAssetCode(c.db, settings);
      const r = await c.db.one<{ id: number }>(
        `INSERT INTO assets (company_id, code, name, equipment_type_id, serial_number, specs, status_id, assigned_to, location, acquired_at, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [c.companyId, code, clean(b.name, 150), b.equipmentTypeId, serial, JSON.stringify(specs), status,
          clean(b.assignedTo, 150), clean(b.location, 150), b.acquiredAt ?? null, clean(b.notes, 1000), c.userId]);
      ids.push(r.id);
      await c.audit('asset.created', 'asset', r.id, { code, quantity: b.quantity });
    }
    const items = await c.db.rows<any>(`${ASSET_SELECT} WHERE a.id = ANY($1::bigint[]) ORDER BY a.id`, [ids]);
    return { items };
  }));

  // ---------- Editar ----------
  app.patch('/api/assets/:id', route('assets.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      equipmentTypeId: zId.optional(),
      name: z.string().max(150).nullable().optional(),
      serialNumber: z.string().max(100).nullable().optional(),
      specs: specsInput.optional(),
      statusId: zId.optional(),
      assignedTo: z.string().max(150).nullable().optional(),
      location: z.string().max(150).nullable().optional(),
      acquiredAt: zDate.nullable().optional(),
      notes: z.string().trim().max(1000).nullable().optional(),
    }));
    const a = await loadAsset(c, id, true);
    const changes: Record<string, unknown> = {};

    // Cambiar el tipo reemplaza los datos técnicos (los atributos dependen del tipo).
    const typeId = b.equipmentTypeId ?? a.equipmentTypeId;
    if (b.equipmentTypeId && b.equipmentTypeId !== a.equipmentTypeId) {
      const t = await c.db.opt<{ is_active: boolean }>('SELECT is_active FROM equipment_types WHERE id = $1', [b.equipmentTypeId]);
      if (!t || !t.is_active) throw badRequest('invalid_equipment_type');
      changes.equipmentTypeId = [a.equipmentTypeId, b.equipmentTypeId];
    }
    let specs: Record<string, unknown> | undefined;
    if (b.specs || typeId !== a.equipmentTypeId) {
      const merged: Record<string, unknown> = typeId !== a.equipmentTypeId ? {} : { ...a.specs };
      for (const [k, v] of Object.entries(b.specs ?? {})) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
      specs = await normalizeSpecs(c.db, typeId, merged, 'draft');
      const diff: Record<string, [unknown, unknown]> = {};
      for (const k of new Set([...Object.keys(a.specs ?? {}), ...Object.keys(specs)])) {
        const x = (a.specs as Record<string, unknown>)?.[k], y = specs[k];
        if (JSON.stringify(x) !== JSON.stringify(y)) diff[k] = [x ?? null, y ?? null];
      }
      if (Object.keys(diff).length) changes.specs = diff;
    }
    const serial = b.serialNumber !== undefined ? clean(b.serialNumber, 100) : undefined;
    if (serial !== undefined) { await assertSerialFree(c, serial, id); if (serial !== a.serialNumber) changes.serial = serial; }
    const name = b.name !== undefined ? clean(b.name, 150) : undefined;
    if (name !== undefined && name !== a.name) changes.name = name;
    const assignedTo = b.assignedTo !== undefined ? clean(b.assignedTo, 150) : undefined;
    if (assignedTo !== undefined && assignedTo !== a.assignedTo) changes.assignedTo = [a.assignedTo, assignedTo];
    const location = b.location !== undefined ? clean(b.location, 150) : undefined;
    if (location !== undefined && location !== a.location) changes.location = [a.location, location];
    if (b.acquiredAt !== undefined && b.acquiredAt !== a.acquiredAt) changes.acquiredAt = b.acquiredAt;
    const notes = b.notes !== undefined ? clean(b.notes, 1000) : undefined;
    if (notes !== undefined && notes !== a.notes) changes.notes = true;
    let statusChange: { from: number; to: number } | null = null;
    if (b.statusId && b.statusId !== a.statusId) {
      await assertCatalogItem(c.db, b.statusId, 'asset_status', 'statusId');
      statusChange = { from: a.statusId, to: b.statusId };
    }

    await c.db.query(
      `UPDATE assets SET equipment_type_id = $2, specs = COALESCE($3::jsonb, specs),
              name = CASE WHEN $4::boolean THEN $5 ELSE name END,
              serial_number = CASE WHEN $6::boolean THEN $7 ELSE serial_number END,
              status_id = COALESCE($8::bigint, status_id),
              assigned_to = CASE WHEN $9::boolean THEN $10 ELSE assigned_to END,
              location = CASE WHEN $11::boolean THEN $12 ELSE location END,
              acquired_at = CASE WHEN $13::boolean THEN $14::date ELSE acquired_at END,
              notes = CASE WHEN $15::boolean THEN $16 ELSE notes END
        WHERE id = $1`,
      [id, typeId, specs ? JSON.stringify(specs) : null, name !== undefined, name ?? null, serial !== undefined, serial ?? null,
        statusChange?.to ?? null, assignedTo !== undefined, assignedTo ?? null, location !== undefined, location ?? null,
        b.acquiredAt !== undefined, b.acquiredAt ?? null, notes !== undefined, notes ?? null]);

    if (Object.keys(changes).length) await c.audit('asset.updated', 'asset', id, changes);
    if (statusChange) await c.audit('asset.status_changed', 'asset', id, statusChange);
    return loadAsset(c, id);
  }));

  // ---------- Eliminar (por error de registro; para dejar de usarlo, cambiar el estado a "Dado de baja") ----------
  app.delete('/api/assets/:id', route('assets.manage', async (c) => {
    const { id } = c.params(zIdParam);
    const a = await loadAsset(c, id, true);
    await c.db.query('DELETE FROM assets WHERE id = $1', [id]);
    await c.audit('asset.deleted', 'asset', id, { code: a.code, name: a.name, serialNumber: a.serialNumber });
    return { ok: true };
  }));
}
