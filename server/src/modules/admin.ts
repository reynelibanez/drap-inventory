import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { route, zId, zPage } from '../http.js';
import { DEFAULT_SETTINGS, assertValidPatch, getSettings } from '../settings.js';

export async function adminRoutes(app: FastifyInstance) {
  // ---------- Historial de cambios ----------
  app.get('/api/audit', route('audit.view', async (c) => {
    const q = c.query(zPage.extend({
      entity: z.string().max(40).optional(), entityId: zId.optional(), userId: zId.optional(),
      action: z.string().max(60).optional(), from: z.string().date().optional(), to: z.string().date().optional(),
    }));
    const p: unknown[] = [];
    const where: string[] = [];
    if (q.entity) { p.push(q.entity); where.push(`a.entity = $${p.length}`); }
    if (q.entityId) { p.push(q.entityId); where.push(`a.entity_id = $${p.length}`); }
    if (q.userId) { p.push(q.userId); where.push(`a.user_id = $${p.length}`); }
    if (q.action) { p.push(`${q.action.replace(/[\\%_]/g, (m) => '\\' + m)}%`); where.push(`a.action LIKE $${p.length}`); }
    if (q.from) { p.push(q.from); where.push(`a.at >= $${p.length}::date`); }
    if (q.to) { p.push(q.to); where.push(`a.at < ($${p.length}::date + 1)`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log a ${w}`, p)).n;
    const items = await c.db.rows(
      `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.data, a.user_id AS "userId", u.full_name AS "userName"
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${w}
        ORDER BY a.id DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, p);
    return { items, total };
  }));

  // ---------- Empresa y ajustes ----------
  app.get('/api/company', route('settings.manage', async (c) => {
    const co = await c.db.opt(
      `SELECT id, name, legal_name AS "legalName", tax_id AS "taxId", default_language AS "defaultLanguage", currency, timezone FROM companies WHERE id = $1`, [c.companyId]);
    if (!co) throw notFound();
    return { company: co, settings: await getSettings(c.db, c.companyId), defaults: DEFAULT_SETTINGS };
  }));

  app.patch('/api/company', route('settings.manage', async (c) => {
    const b = c.body(z.object({
      name: z.string().trim().min(2).max(120).optional(),
      legalName: z.string().trim().max(200).nullable().optional(),
      taxId: z.string().trim().max(50).nullable().optional(),
      defaultLanguage: z.enum(['es', 'en']).optional(),
      currency: z.string().length(3).toUpperCase().optional(),
      timezone: z.string().min(3).max(60).optional(),
      settings: z.unknown().optional(),
    }));
    const patch = b.settings !== undefined ? assertValidPatch(b.settings) : null;
    const current = await getSettings(c.db, c.companyId);
    const merged = patch ? { ...current, ...patch, placement: { ...current.placement, ...(patch.placement ?? {}) } } : null;
    await c.db.query(
      `UPDATE companies SET name = COALESCE($2, name),
              legal_name = CASE WHEN $3::boolean THEN $4 ELSE legal_name END,
              tax_id = CASE WHEN $5::boolean THEN $6 ELSE tax_id END,
              default_language = COALESCE($7, default_language), currency = COALESCE($8, currency), timezone = COALESCE($9, timezone),
              settings = COALESCE($10::jsonb, settings)
        WHERE id = $1`,
      [c.companyId, b.name ?? null, b.legalName !== undefined, b.legalName ?? null, b.taxId !== undefined, b.taxId ?? null,
        b.defaultLanguage ?? null, b.currency ?? null, b.timezone ?? null, merged ? JSON.stringify(merged) : null]);
    await c.audit('company.updated', 'company', c.companyId);
    return { ok: true };
  }));
}
