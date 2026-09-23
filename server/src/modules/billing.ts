import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withGlobal } from '../db.js';
import { badRequest } from '../errors.js';
import { route } from '../http.js';
import {
  applyStripeEvent, billingSummary, createCheckoutSession, createPortalSession, currentUsage,
  getCompanyBilling, listPlans, stripeClient, stripeConfigured, syncCompanySubscription,
} from '../services/billing.js';

export async function billingRoutes(app: FastifyInstance) {
  // Funciona incluso con la suscripción vencida: si no, nadie podría pagar para desbloquearse.
  app.get('/api/billing/status', route(null, async (c) => {
    const b = await getCompanyBilling(c.db, c.companyId);
    const plans = await listPlans(c.db);
    const usage = await currentUsage(c.db, c.companyId);
    return { ...(b ? billingSummary(b) : {}), stripeConfigured: stripeConfigured(), plans, usage };
  }, { skipBillingGate: true }));

  app.post('/api/billing/checkout', route('billing.manage', async (c) => {
    const b = c.body(z.object({ planKey: z.string().min(1).max(40), interval: z.enum(['monthly', 'annual']) }));
    const url = await createCheckoutSession(c.db, c.companyId, b.planKey, b.interval);
    await c.audit('billing.checkout_started', 'company', c.companyId, { planKey: b.planKey, interval: b.interval });
    return { url };
  }, { skipBillingGate: true }));

  app.post('/api/billing/portal', route('billing.manage', async (c) => {
    const url = await createPortalSession(c.db, c.companyId);
    return { url };
  }, { skipBillingGate: true }));

  // Respaldo cuando el webhook no puede llegar (servidor local sin dirección pública): vuelve a
  // preguntarle a Stripe. Se llama sola al volver del Checkout, y también hay un botón manual.
  app.post('/api/billing/sync', route('billing.manage', async (c) => {
    await syncCompanySubscription(c.db, c.companyId);
    const b = await getCompanyBilling(c.db, c.companyId);
    return b ? billingSummary(b) : { blocked: true };
  }, { skipBillingGate: true }));
}

/**
 * Webhook de Stripe: no lleva sesión (lo llama Stripe directamente), la seguridad es la firma.
 * Necesita el cuerpo crudo (sin parsear) para verificar la firma, así que usa su propio parser,
 * aislado del resto de la app (no afecta a las demás rutas JSON).
 */
export async function stripeWebhookRoutes(app: FastifyInstance) {
  await app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    instance.post('/api/webhooks/stripe', async (req, reply) => {
      const stripe = stripeClient();
      if (!stripe || !config.stripe.webhookSecret) return reply.status(503).send({ error: { code: 'stripe_not_configured', params: {} } });
      const sig = req.headers['stripe-signature'];
      if (!sig || Array.isArray(sig)) throw badRequest('missing_signature');
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripe.webhookSecret);
      } catch (err: any) {
        req.log.warn({ err }, 'firma de webhook de Stripe inválida');
        return reply.status(400).send({ error: { code: 'invalid_signature', params: {} } });
      }
      const result = await withGlobal((db) => applyStripeEvent(db, event));
      return reply.send({ received: true, applied: result.applied });
    });
  });
}
