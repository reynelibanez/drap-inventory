import Stripe from 'stripe';
import { config } from '../config.js';
import type { Db } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { invalidateAccessCache } from '../http.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
export type BillingInterval = 'monthly' | 'annual';

export interface PlanRow {
  id: number;
  key: string;
  name: Record<string, string>;
  description: Record<string, string>;
  priceMonthlyCents: number | null;
  priceAnnualCents: number | null;
  maxUsers: number | null;
  maxLocations: number | null;
  features: Record<string, boolean>;
  stripePriceIdMonthly: string | null;
  stripePriceIdAnnual: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface CompanyBillingRow {
  companyId: number;
  planId: number | null;
  subscriptionStatus: SubscriptionStatus;
  billingInterval: BillingInterval | null;
  trialEndsAt: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  subscriptionCanceledAt: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  plan: PlanRow | null;
}

const PLAN_COLS = `p.id, p.key, p.name, p.description,
  p.price_monthly_cents AS "priceMonthlyCents", p.price_annual_cents AS "priceAnnualCents",
  p.max_users AS "maxUsers", p.max_locations AS "maxLocations", p.features,
  p.stripe_price_id_monthly AS "stripePriceIdMonthly", p.stripe_price_id_annual AS "stripePriceIdAnnual",
  p.is_active AS "isActive", p.sort_order AS "sortOrder"`;

/** Stripe todavía no está configurado (faltan las claves en .env). */
export function stripeConfigured(): boolean {
  return !!config.stripe.secretKey;
}

let stripeSingleton: Stripe | null | undefined;
/** Cliente de Stripe, o null si aún no se configuraron las claves. */
export function stripeClient(): Stripe | null {
  if (stripeSingleton !== undefined) return stripeSingleton;
  stripeSingleton = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;
  return stripeSingleton;
}

export async function listPlans(db: Db, activeOnly = true): Promise<PlanRow[]> {
  return db.rows<PlanRow>(`SELECT ${PLAN_COLS} FROM subscription_plans p ${activeOnly ? 'WHERE p.is_active' : ''} ORDER BY p.sort_order`);
}

export async function getPlan(db: Db, id: number): Promise<PlanRow | null> {
  return db.opt<PlanRow>(`SELECT ${PLAN_COLS} FROM subscription_plans p WHERE p.id = $1`, [id]);
}

export async function getPlanByKey(db: Db, key: string): Promise<PlanRow | null> {
  return db.opt<PlanRow>(`SELECT ${PLAN_COLS} FROM subscription_plans p WHERE lower(p.key) = lower($1)`, [key]);
}

/** Trae el estado de suscripción de una empresa (sin depender de la empresa activa: funciona desde withGlobal). */
export async function getCompanyBilling(db: Db, companyId: number): Promise<CompanyBillingRow | null> {
  const row = await db.opt<any>(
    `SELECT c.id AS "companyId", c.plan_id AS "planId", c.subscription_status AS "subscriptionStatus",
            c.billing_interval AS "billingInterval", c.trial_ends_at AS "trialEndsAt",
            c.subscription_current_period_end AS "subscriptionCurrentPeriodEnd",
            c.subscription_canceled_at AS "subscriptionCanceledAt",
            c.stripe_customer_id AS "stripeCustomerId", c.stripe_subscription_id AS "stripeSubscriptionId",
            ${PLAN_COLS}
       FROM companies c LEFT JOIN subscription_plans p ON p.id = c.plan_id
      WHERE c.id = $1`, [companyId]);
  if (!row) return null;
  const { id, key, name, description, priceMonthlyCents, priceAnnualCents, maxUsers, maxLocations, features,
    stripePriceIdMonthly, stripePriceIdAnnual, isActive, sortOrder, ...company } = row;
  const plan: PlanRow | null = id == null ? null : {
    id, key, name, description, priceMonthlyCents, priceAnnualCents, maxUsers, maxLocations, features,
    stripePriceIdMonthly, stripePriceIdAnnual, isActive, sortOrder,
  };
  return { ...company, plan };
}

/** ¿La empresa está bloqueada (sin poder usar el sistema) según su estado de suscripción? */
export function isBillingBlocked(b: Pick<CompanyBillingRow, 'subscriptionStatus' | 'trialEndsAt'>): boolean {
  if (b.subscriptionStatus === 'expired' || b.subscriptionStatus === 'canceled') return true;
  if (b.subscriptionStatus === 'trialing') return !!b.trialEndsAt && new Date(b.trialEndsAt).getTime() < Date.now();
  // 'active' y 'past_due' (reintento de cobro en curso) siguen con acceso.
  return false;
}

export function billingSummary(b: CompanyBillingRow) {
  return {
    plan: b.plan,
    status: b.subscriptionStatus,
    billingInterval: b.billingInterval,
    trialEndsAt: b.trialEndsAt,
    currentPeriodEnd: b.subscriptionCurrentPeriodEnd,
    canceledAt: b.subscriptionCanceledAt,
    hasStripeCustomer: !!b.stripeCustomerId,
    blocked: isBillingBlocked(b),
  };
}

/** Cuántos usuarios activos y almacenes activos tiene hoy la empresa (para validar límites del plan y mostrarlos en pantalla). */
export async function currentUsage(db: Db, companyId: number): Promise<{ users: number; locations: number }> {
  const [u, l] = await Promise.all([
    db.one<{ n: number }>('SELECT count(*)::int AS n FROM memberships WHERE company_id = $1 AND is_active', [companyId]),
    db.one<{ n: number }>('SELECT count(*)::int AS n FROM warehouses WHERE company_id = $1 AND is_active', [companyId]),
  ]);
  return { users: u.n, locations: l.n };
}

/** Lanza 402 si agregar un usuario más superaría el límite del plan actual. Null/plan sin límite = no revisa. */
export async function assertUserLimit(db: Db, companyId: number): Promise<void> {
  const b = await getCompanyBilling(db, companyId);
  const max = b?.plan?.maxUsers;
  if (max == null) return;
  const { users } = await currentUsage(db, companyId);
  if (users >= max) throw badRequest('plan_user_limit', { max }, `El plan permite hasta ${max} usuarios`);
}

/** Lanza 402 si agregar un almacén más superaría el límite del plan actual. */
export async function assertLocationLimit(db: Db, companyId: number): Promise<void> {
  const b = await getCompanyBilling(db, companyId);
  const max = b?.plan?.maxLocations;
  if (max == null) return;
  const { locations } = await currentUsage(db, companyId);
  if (locations >= max) throw badRequest('plan_location_limit', { max }, `El plan permite hasta ${max} almacenes`);
}

/** Trae (o crea) el cliente de Stripe correspondiente a la empresa. */
export async function ensureStripeCustomer(db: Db, companyId: number): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw badRequest('stripe_not_configured');
  const company = await db.one<{ name: string; stripe_customer_id: string | null; email: string | null; username: string | null }>(
    `SELECT c.name, c.stripe_customer_id,
            (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = c.id AND m.is_company_admin AND u.email IS NOT NULL ORDER BY m.id LIMIT 1) AS email,
            (SELECT u.username FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.company_id = c.id AND m.is_company_admin ORDER BY m.id LIMIT 1) AS username
       FROM companies c WHERE c.id = $1`, [companyId]);
  if (company.stripe_customer_id) return company.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: company.name,
    email: company.email ?? undefined,
    metadata: { companyId: String(companyId), companyUsername: company.username ?? '' },
  });
  await db.query('UPDATE companies SET stripe_customer_id = $2 WHERE id = $1', [companyId, customer.id]);
  return customer.id;
}

/** Crea una sesión de Stripe Checkout para suscribir la empresa a un plan (mensual o anual). */
export async function createCheckoutSession(db: Db, companyId: number, planKey: string, interval: BillingInterval): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw badRequest('stripe_not_configured');
  const plan = await getPlanByKey(db, planKey);
  if (!plan || !plan.isActive) throw notFound('plan_not_found');
  const priceId = interval === 'annual' ? plan.stripePriceIdAnnual : plan.stripePriceIdMonthly;
  if (!priceId) throw badRequest('plan_not_purchasable');
  const customerId = await ensureStripeCustomer(db, companyId);
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${config.stripe.appUrl}/settings/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.stripe.appUrl}/settings/billing?checkout=canceled`,
    subscription_data: { metadata: { companyId: String(companyId), planKey, interval } },
    metadata: { companyId: String(companyId), planKey, interval },
    allow_promotion_codes: true,
  });
  if (!session.url) throw badRequest('stripe_session_without_url');
  return session.url;
}

/** Crea una sesión del portal de facturación de Stripe (cambiar tarjeta, cancelar, ver facturas). */
export async function createPortalSession(db: Db, companyId: number): Promise<string> {
  const stripe = stripeClient();
  if (!stripe) throw badRequest('stripe_not_configured');
  const b = await getCompanyBilling(db, companyId);
  if (!b?.stripeCustomerId) throw conflict('no_stripe_customer');
  const session = await stripe.billingPortal.sessions.create({
    customer: b.stripeCustomerId,
    return_url: `${config.stripe.appUrl}/settings/billing`,
  });
  return session.url;
}

/**
 * Vuelve a preguntarle a Stripe por la suscripción actual de la empresa y actualiza la base.
 * Sirve de respaldo cuando el webhook no puede llegar (por ejemplo, un servidor en una PC local sin
 * dirección pública): se llama al volver del Checkout, y también hay un botón "Actualizar estado".
 */
export async function syncCompanySubscription(db: Db, companyId: number): Promise<void> {
  const stripe = stripeClient();
  if (!stripe) return;
  const company = await db.opt<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM companies WHERE id = $1', [companyId]);
  if (!company?.stripe_customer_id) return;
  const subs = await stripe.subscriptions.list({ customer: company.stripe_customer_id, status: 'all', limit: 3 });
  // La más reciente que no esté totalmente cancelada/incompleta manda.
  const sub = subs.data.sort((a, b) => b.created - a.created)[0];
  if (sub) await applySubscription(db, sub);
}

/** El admin de plataforma asigna un plan a cualquier empresa sin pasar por Stripe (sin cobro). */
export async function overrideCompanyPlan(
  db: Db, companyId: number,
  b: { planKey: string; status: SubscriptionStatus; interval?: BillingInterval | null; periodEnd?: string | null },
): Promise<void> {
  const plan = await getPlanByKey(db, b.planKey);
  if (!plan) throw notFound('plan_not_found');
  const r = await db.query(
    `UPDATE companies SET plan_id = $2, subscription_status = $3, billing_interval = $4,
                          subscription_current_period_end = $5, subscription_canceled_at = NULL
      WHERE id = $1`,
    [companyId, plan.id, b.status, b.interval ?? null, b.periodEnd ?? null]);
  if (!r.rowCount) throw notFound('company_not_found');
  invalidateAccessCache();
}

// ---------------------------------------------------------------------
// Webhooks de Stripe
// ---------------------------------------------------------------------

async function companyIdForCustomer(db: Db, customerId: string): Promise<number | null> {
  const row = await db.opt<{ id: number }>('SELECT id FROM companies WHERE stripe_customer_id = $1', [customerId]);
  return row?.id ?? null;
}

function mapStripeStatus(s: Stripe.Subscription.Status): SubscriptionStatus {
  switch (s) {
    case 'active': case 'trialing': return 'active';
    case 'past_due': case 'unpaid': case 'incomplete': return 'past_due';
    case 'canceled': case 'incomplete_expired': return 'canceled';
    default: return 'past_due';
  }
}

async function applySubscription(db: Db, sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const companyId = await companyIdForCustomer(db, customerId);
  if (!companyId) return; // suscripción de otra cosa / cliente sin empresa asociada
  const price = sub.items.data[0]?.price;
  let planId: number | null = null;
  let interval: BillingInterval | null = null;
  if (price) {
    const plan = await db.opt<{ id: number }>(
      'SELECT id FROM subscription_plans WHERE stripe_price_id_monthly = $1 OR stripe_price_id_annual = $1', [price.id]);
    planId = plan?.id ?? null;
    interval = price.recurring?.interval === 'year' ? 'annual' : 'monthly';
  }
  const periodEnd = sub.items.data[0]?.current_period_end;
  const status = mapStripeStatus(sub.status);
  await db.query(
    `UPDATE companies SET
        plan_id = COALESCE($2, plan_id),
        subscription_status = $3,
        billing_interval = COALESCE($4, billing_interval),
        stripe_subscription_id = $5,
        subscription_current_period_end = $6,
        subscription_canceled_at = CASE WHEN $3 = 'canceled' THEN now() ELSE subscription_canceled_at END
      WHERE id = $1`,
    [companyId, planId, status, interval, sub.id, periodEnd ? new Date(periodEnd * 1000).toISOString() : null]);
  invalidateAccessCache();
}

async function applySubscriptionDeleted(db: Db, sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const companyId = await companyIdForCustomer(db, customerId);
  if (!companyId) return;
  await db.query(
    `UPDATE companies SET subscription_status = 'canceled', subscription_canceled_at = now() WHERE id = $1 AND stripe_subscription_id = $2`,
    [companyId, sub.id]);
  invalidateAccessCache();
}

/** Procesa un evento de Stripe ya verificado (firma correcta). Idempotente: usa la tabla stripe_events. */
export async function applyStripeEvent(db: Db, event: Stripe.Event): Promise<{ applied: boolean }> {
  const inserted = await db.query('INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [event.id, event.type]);
  if (!inserted.rowCount) return { applied: false }; // ya procesado antes

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === 'subscription' && session.subscription) {
        const stripe = stripeClient();
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
        const sub = stripe ? await stripe.subscriptions.retrieve(subId) : null;
        if (sub) await applySubscription(db, sub);
      }
      break;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await applySubscription(db, event.data.object as Stripe.Subscription);
      break;
    case 'customer.subscription.deleted':
      await applySubscriptionDeleted(db, event.data.object as Stripe.Subscription);
      break;
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const companyId = await companyIdForCustomer(db, customerId);
        if (companyId) {
          await db.query(`UPDATE companies SET subscription_status = 'past_due' WHERE id = $1 AND subscription_status = 'active'`, [companyId]);
          invalidateAccessCache();
        }
      }
      break;
    }
    default:
      break; // otros eventos no nos interesan
  }
  return { applied: true };
}
