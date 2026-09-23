import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors.js';
import { invalidateAccessCache, userRoute, zI18n, zId, zIdParam } from '../http.js';
import { addMember, createCompanyWithAdmin } from '../services/companies.js';
import { billingSummary, getCompanyBilling, listPlans, overrideCompanyPlan } from '../services/billing.js';

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().min(2).max(40).regex(/^[a-z0-9-]+$/).optional(),
  legalName: z.string().trim().max(200).nullish(),
  taxId: z.string().trim().max(50).nullish(),
  defaultLanguage: z.enum(['es', 'en']).default('es'),
  currency: z.string().length(3).toUpperCase().default('USD'),
  timezone: z.string().min(3).max(60).default('America/New_York'),
  /** Primer administrador: un usuario nuevo o uno ya existente. */
  admin: z.union([
    z.object({ existingUserId: zId }),
    z.object({
      username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/),
      fullName: z.string().trim().min(2).max(120),
      email: z.string().trim().email().nullish(),
      password: z.string().min(1).max(200),
    }),
  ]),
});

/** Administración de la plataforma: alta y gestión de empresas (solo administradores de plataforma). */
export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/companies', userRoute(async (c) => {
    const rows = await c.db.rows<any>(
      `SELECT c.id, c.slug, c.name, c.legal_name AS "legalName", c.default_language AS "defaultLanguage", c.currency, c.is_active AS "isActive",
              c.created_at AS "createdAt",
              (SELECT count(*) FROM memberships m WHERE m.company_id = c.id AND m.is_active)::int AS members,
              (SELECT count(*) FROM warehouses w WHERE w.company_id = c.id AND w.is_active)::int AS locations,
              EXISTS (SELECT 1 FROM memberships m WHERE m.company_id = c.id AND m.user_id = $1 AND m.is_active) AS "iAmMember",
              p.key AS "planKey", p.name AS "planName",
              c.subscription_status AS "subscriptionStatus", c.billing_interval AS "billingInterval",
              c.trial_ends_at AS "trialEndsAt", c.subscription_current_period_end AS "subscriptionCurrentPeriodEnd"
         FROM companies c LEFT JOIN subscription_plans p ON p.id = c.plan_id
        ORDER BY c.name`, [c.userId]);
    return { items: rows };
  }, { platformAdmin: true }));

  // ---------- Planes de suscripción (catálogo editable) ----------
  app.get('/api/platform/plans', userRoute(async (c) => {
    return { items: await listPlans(c.db, false) };
  }, { platformAdmin: true }));

  app.patch('/api/platform/plans/:id', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      name: zI18n.optional(),
      description: zI18n.optional(),
      priceMonthlyCents: z.number().int().min(0).nullable().optional(),
      priceAnnualCents: z.number().int().min(0).nullable().optional(),
      maxUsers: z.number().int().positive().nullable().optional(),
      maxLocations: z.number().int().positive().nullable().optional(),
      features: z.record(z.string(), z.boolean()).optional(),
      stripePriceIdMonthly: z.string().trim().max(120).nullable().optional(),
      stripePriceIdAnnual: z.string().trim().max(120).nullable().optional(),
      isActive: z.boolean().optional(),
    }));
    const r = await c.db.query(
      `UPDATE subscription_plans SET
         name = COALESCE($2, name), description = COALESCE($3, description),
         price_monthly_cents = CASE WHEN $4::boolean THEN $5 ELSE price_monthly_cents END,
         price_annual_cents = CASE WHEN $6::boolean THEN $7 ELSE price_annual_cents END,
         max_users = CASE WHEN $8::boolean THEN $9 ELSE max_users END,
         max_locations = CASE WHEN $10::boolean THEN $11 ELSE max_locations END,
         features = COALESCE($12, features),
         stripe_price_id_monthly = CASE WHEN $13::boolean THEN $14 ELSE stripe_price_id_monthly END,
         stripe_price_id_annual = CASE WHEN $15::boolean THEN $16 ELSE stripe_price_id_annual END,
         is_active = COALESCE($17, is_active)
       WHERE id = $1`,
      [id, b.name ? JSON.stringify(b.name) : null, b.description ? JSON.stringify(b.description) : null,
       b.priceMonthlyCents !== undefined, b.priceMonthlyCents ?? null,
       b.priceAnnualCents !== undefined, b.priceAnnualCents ?? null,
       b.maxUsers !== undefined, b.maxUsers ?? null,
       b.maxLocations !== undefined, b.maxLocations ?? null,
       b.features ? JSON.stringify(b.features) : null,
       b.stripePriceIdMonthly !== undefined, b.stripePriceIdMonthly ?? null,
       b.stripePriceIdAnnual !== undefined, b.stripePriceIdAnnual ?? null,
       b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    return { ok: true };
  }, { platformAdmin: true }));

  // ---------- Cambiar el plan de cualquier empresa, sin pago (anulación manual) ----------
  app.get('/api/platform/companies/:id/billing', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    const b = await getCompanyBilling(c.db, id);
    if (!b) throw notFound();
    return billingSummary(b);
  }, { platformAdmin: true }));

  app.post('/api/platform/companies/:id/plan', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      planKey: z.string().min(1).max(40),
      status: z.enum(['trialing', 'active', 'past_due', 'canceled', 'expired']).default('active'),
      interval: z.enum(['monthly', 'annual']).nullable().optional(),
      /** Fecha hasta la que queda válido este cambio manual (vacío = sin vencimiento). */
      periodEnd: z.string().datetime().nullable().optional(),
    }));
    await overrideCompanyPlan(c.db, id, { planKey: b.planKey, status: b.status, interval: b.interval, periodEnd: b.periodEnd });
    return { ok: true };
  }, { platformAdmin: true }));

  app.get('/api/platform/users', userRoute(async (c) => {
    const items = await c.db.rows(
      `SELECT id, username, email, full_name AS "fullName", is_active AS "isActive", is_platform_admin AS "isPlatformAdmin"
         FROM users ORDER BY full_name`);
    return { items };
  }, { platformAdmin: true }));

  app.post('/api/platform/companies', userRoute(async (c) => {
    const b = c.body(createSchema);
    const r = await createCompanyWithAdmin(c.db, {
      name: b.name, slug: b.slug, legalName: b.legalName, taxId: b.taxId, defaultLanguage: b.defaultLanguage,
      currency: b.currency, timezone: b.timezone, admin: b.admin,
    });
    return { id: r.id, slug: r.slug };
  }, { platformAdmin: true }));

  app.patch('/api/platform/companies/:id', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    const b = c.body(z.object({
      name: z.string().trim().min(2).max(120).optional(),
      legalName: z.string().trim().max(200).nullable().optional(),
      isActive: z.boolean().optional(),
    }));
    const r = await c.db.query(
      `UPDATE companies SET name = COALESCE($2, name),
                            legal_name = CASE WHEN $3::boolean THEN $4 ELSE legal_name END,
                            is_active = COALESCE($5, is_active)
        WHERE id = $1`,
      [id, b.name ?? null, b.legalName !== undefined, b.legalName ?? null, b.isActive ?? null]);
    if (!r.rowCount) throw notFound();
    invalidateAccessCache();
    return { ok: true };
  }, { platformAdmin: true }));

  /** El administrador de plataforma se agrega como administrador de una empresa (para soporte). */
  app.post('/api/platform/companies/:id/join', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    if (!(await c.db.opt('SELECT 1 FROM companies WHERE id = $1', [id]))) throw notFound();
    if (await c.db.opt('SELECT 1 FROM memberships WHERE company_id = $1 AND user_id = $2', [id, c.userId])) return { ok: true, already: true };
    await c.db.query("SELECT set_config('app.company_id', $1, true)", [String(id)]);
    await addMember(c.db, id, c.userId, true);
    invalidateAccessCache();
    return { ok: true };
  }, { platformAdmin: true }));
}
