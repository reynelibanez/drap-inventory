import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, withGlobal } from '../src/db.js';
import { invalidateAccessCache } from '../src/http.js';
import { applyStripeEvent } from '../src/services/billing.js';
import { login, makeCompany, startApi, stopApi, type Api } from './helpers.js';

let api: Api;
let X: { id: number };
let tokX: string;
let tokStaffX: string; // usuario normal (no admin de plataforma) de la empresa X, para probar el bloqueo sin el "pase libre" del admin de plataforma

beforeAll(async () => {
  api = await startApi();
  X = await makeCompany('Xenon Tech', 'adminX');
  tokX = (await login(api, 'adminX')).token;
  const staff = await api.call('POST', '/api/team/members', tokX, { username: 'staffX', fullName: 'Staff X', password: 'password123' });
  expect(staff.status, JSON.stringify(staff.body)).toBe(200);
  tokStaffX = (await login(api, 'staffX')).token;
});
afterAll(async () => {
  // Solo puede existir un administrador de plataforma a la vez (índice único global):
  // hay que devolver a adminX a la normalidad para no interferir con otros archivos de prueba.
  await pool.query("UPDATE users SET is_platform_admin = false WHERE username = 'adminX'");
  await stopApi(api);
});

describe('suscripciones: estado por defecto', () => {
  it('una empresa nueva arranca en el plan gratis, en período de prueba y sin bloqueo', async () => {
    const r = await api.call('GET', '/api/billing/status', tokX);
    expect(r.status).toBe(200);
    expect(r.body.plan.key).toBe('free');
    expect(r.body.status).toBe('trialing');
    expect(r.body.blocked).toBe(false);
    expect(r.body.trialEndsAt).toBeTruthy();
    expect(Array.isArray(r.body.plans)).toBe(true);
    expect(r.body.plans.map((p: any) => p.key).sort()).toEqual(['business', 'enterprise', 'free']);
  });

  it('sin claves de Stripe configuradas, comprar/portal fallan con un error claro (no rompe)', async () => {
    const checkout = await api.call('POST', '/api/billing/checkout', tokX, { planKey: 'business', interval: 'monthly' });
    expect(checkout.status).toBe(400);
    expect(checkout.body.error.code).toBe('stripe_not_configured');
    const portal = await api.call('POST', '/api/billing/portal', tokX, {});
    expect(portal.status).toBe(400);
    expect(portal.body.error.code).toBe('stripe_not_configured');
  });
});

describe('suscripciones: bloqueo por prueba vencida', () => {
  it('vencido el trial, las rutas normales quedan bloqueadas con 402 pero /billing/status sigue funcionando', async () => {
    await pool.query("UPDATE companies SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [X.id]);

    const blocked = await api.call('GET', '/api/meta', tokStaffX);
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('subscription_expired');

    const status = await api.call('GET', '/api/billing/status', tokStaffX);
    expect(status.status).toBe(200);
    expect(status.body.blocked).toBe(true);
  });

  it('el admin de plataforma puede entrar a una empresa bloqueada (para dar soporte) y desbloquearla asignándole un plan sin pago', async () => {
    // Solo puede haber un administrador de plataforma a la vez (índice único global); otro archivo
    // de prueba pudo haber dejado uno puesto, así que primero se libera.
    await pool.query('UPDATE users SET is_platform_admin = false WHERE is_platform_admin');
    await pool.query("UPDATE users SET is_platform_admin = true WHERE username = 'adminX'");
    invalidateAccessCache();
    const tokPlatform = (await login(api, 'adminX')).token;
    // El propio admin de plataforma nunca queda bloqueado, aunque su empresa lo esté.
    expect((await api.call('GET', '/api/team/members', tokPlatform)).status).toBe(200);

    const before = await api.call('GET', '/api/platform/companies', tokPlatform);
    expect(before.status).toBe(200);
    const mine = before.body.items.find((c: any) => c.id === X.id);
    expect(mine.planKey).toBe('free');
    expect(mine.subscriptionStatus).toBe('trialing');
    expect(mine.locations).toBe(0);

    const override = await api.call('POST', `/api/platform/companies/${X.id}/plan`, tokPlatform, { planKey: 'business', status: 'active' });
    expect(override.status, JSON.stringify(override.body)).toBe(200);

    // Un usuario normal (no admin de plataforma) de la empresa ya no está bloqueado.
    const nowOk = await api.call('GET', '/api/meta', tokStaffX);
    expect(nowOk.status).toBe(200);

    const status = await api.call('GET', '/api/billing/status', tokStaffX);
    expect(status.body.plan.key).toBe('business');
    expect(status.body.status).toBe('active');
    expect(status.body.blocked).toBe(false);
  });
});

describe('suscripciones: límites del plan', () => {
  let Y: { id: number };
  let tokY: string;

  beforeAll(async () => {
    Y = await makeCompany('Ypsilon Refurb', 'adminY');
    await withGlobal((db) => db.query(
      "UPDATE companies SET plan_id = (SELECT id FROM subscription_plans WHERE key = 'business'), subscription_status = 'active' WHERE id = $1",
      [Y.id]));
    tokY = (await login(api, 'adminY')).token;
  });

  it('no deja pasar del máximo de usuarios del plan (Business: 5)', async () => {
    // Ya existe 1 (el admin). Se agregan 4 más para llegar a 5 (el límite).
    for (let i = 1; i <= 4; i++) {
      const r = await api.call('POST', '/api/team/members', tokY, { username: `usery${i}`, fullName: `User ${i}`, password: 'password123' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const sixth = await api.call('POST', '/api/team/members', tokY, { username: 'usery5', fullName: 'User 5', password: 'password123' });
    expect(sixth.status).toBe(400);
    expect(sixth.body.error.code).toBe('plan_user_limit');
    expect(sixth.body.error.params.max).toBe(5);
  });

  it('no deja pasar del máximo de almacenes del plan (Business: 2)', async () => {
    const w1 = await api.call('POST', '/api/warehouses', tokY, { code: 'W1', name: 'Almacén 1' });
    expect(w1.status).toBe(200);
    const w2 = await api.call('POST', '/api/warehouses', tokY, { code: 'W2', name: 'Almacén 2' });
    expect(w2.status).toBe(200);
    const w3 = await api.call('POST', '/api/warehouses', tokY, { code: 'W3', name: 'Almacén 3' });
    expect(w3.status).toBe(400);
    expect(w3.body.error.code).toBe('plan_location_limit');
    expect(w3.body.error.params.max).toBe(2);
  });

  it('Enterprise no tiene límites', async () => {
    await withGlobal((db) => db.query(
      "UPDATE companies SET plan_id = (SELECT id FROM subscription_plans WHERE key = 'enterprise') WHERE id = $1", [Y.id]));
    const w = await api.call('POST', '/api/warehouses', tokY, { code: 'W4', name: 'Almacén 4' });
    expect(w.status).toBe(200);
  });
});

describe('suscripciones: eventos de Stripe (webhooks)', () => {
  it('sin firma o sin Stripe configurado, el endpoint responde con un error controlado, no revienta', async () => {
    const noSig = await api.call('POST', '/api/webhooks/stripe', null, { hello: 'world' });
    expect([400, 503]).toContain(noSig.status);
  });

  it('aplica un evento válido y actualiza la empresa (probado directo contra el servicio, sin red)', async () => {
    const Z = await makeCompany('Zeta Corp', 'adminBillZ');
    await pool.query("UPDATE companies SET stripe_customer_id = 'cus_test_zeta' WHERE id = $1", [Z.id]);
    await pool.query("UPDATE subscription_plans SET stripe_price_id_monthly = 'price_test_business_m' WHERE key = 'business'");

    const fakeSub: any = {
      id: 'sub_test_1', customer: 'cus_test_zeta', status: 'active',
      items: { data: [{ price: { id: 'price_test_business_m', recurring: { interval: 'month' } }, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 }] },
    };
    const event: any = { id: 'evt_test_1', type: 'customer.subscription.updated', data: { object: fakeSub } };

    const applied1 = await withGlobal((db) => applyStripeEvent(db, event));
    expect(applied1.applied).toBe(true);

    const row = await pool.query(
      `SELECT c.subscription_status, c.billing_interval, c.stripe_subscription_id, p.key AS "planKey"
         FROM companies c LEFT JOIN subscription_plans p ON p.id = c.plan_id WHERE c.id = $1`, [Z.id]);
    expect(row.rows[0].subscription_status).toBe('active');
    expect(row.rows[0].billing_interval).toBe('monthly');
    expect(row.rows[0].stripe_subscription_id).toBe('sub_test_1');
    expect(row.rows[0].planKey).toBe('business');

    // El mismo evento otra vez: no se vuelve a aplicar (idempotencia por id de evento).
    const applied2 = await withGlobal((db) => applyStripeEvent(db, event));
    expect(applied2.applied).toBe(false);
  });

  it('customer.subscription.deleted cancela la suscripción', async () => {
    const W = await makeCompany('Omega Parts', 'adminBillW');
    await pool.query("UPDATE companies SET stripe_customer_id = 'cus_test_omega', stripe_subscription_id = 'sub_test_omega' WHERE id = $1", [W.id]);
    const event: any = { id: 'evt_test_deleted', type: 'customer.subscription.deleted', data: { object: { id: 'sub_test_omega', customer: 'cus_test_omega' } } };
    await withGlobal((db) => applyStripeEvent(db, event));
    const row = await pool.query('SELECT subscription_status, subscription_canceled_at FROM companies WHERE id = $1', [W.id]);
    expect(row.rows[0].subscription_status).toBe('canceled');
    expect(row.rows[0].subscription_canceled_at).toBeTruthy();
  });
});
