import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../errors.js';
import { route, userRoute, zId, zIdParam } from '../http.js';
import { eventsFor, isEventKey, pushToUser, type Lang } from '../services/notifications.js';
import { getVapidKeys, isAllowedPushEndpoint } from '../services/webpush.js';

const MAX_DEVICES_PER_USER = 20;

/** Booleano de la URL: `z.coerce.boolean()` tomaría "false" como verdadero. */
const zFlag = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const b64Len = (s: string) => Buffer.from(s, 'base64url').length;

const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(20).max(40) }),
  userAgent: z.string().max(300).optional(),
});

/**
 * Notificaciones:
 *  - /api/push/*            dispositivos del usuario (suscripciones Web Push). No dependen de la empresa activa.
 *  - /api/notifications/*   bandeja y preferencias, por empresa.
 */
export async function notificationRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ Push: dispositivos
  app.get('/api/push/config', userRoute(async () => ({ publicKey: (await getVapidKeys()).publicKey })));

  app.post('/api/push/subscribe', userRoute(async (c) => {
    const b = c.body(subscriptionSchema);
    if (!isAllowedPushEndpoint(b.endpoint)) throw badRequest('push_endpoint_invalid');
    if (b64Len(b.keys.p256dh) !== 65 || b64Len(b.keys.auth) !== 16) throw badRequest('push_keys_invalid');
    // El mismo navegador puede pasar de un usuario a otro: el dispositivo queda con quien inició sesión.
    const r = await c.db.one<{ id: number }>(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                                            user_agent = EXCLUDED.user_agent, failures = 0
       RETURNING id`,
      [c.userId, b.endpoint, b.keys.p256dh, b.keys.auth, b.userAgent ?? null]);
    // Límite de dispositivos por persona: se conservan los más recientes.
    await c.db.query(
      `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY id DESC LIMIT $2)`,
      [c.userId, MAX_DEVICES_PER_USER]);
    return { id: r.id };
  }));

  app.post('/api/push/unsubscribe', userRoute(async (c) => {
    const { endpoint } = c.body(z.object({ endpoint: z.string().max(2000) }));
    await c.db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [c.userId, endpoint]);
    return { ok: true };
  }));

  app.get('/api/push/subscriptions', userRoute(async (c) => {
    const rows = await c.db.rows(
      `SELECT id, endpoint, user_agent AS "userAgent", created_at AS "createdAt", last_used_at AS "lastUsedAt" FROM push_subscriptions WHERE user_id = $1 ORDER BY id DESC`, [c.userId]);
    return { items: rows };
  }));

  app.delete('/api/push/subscriptions/:id', userRoute(async (c) => {
    const { id } = c.params(zIdParam);
    const r = await c.db.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2', [id, c.userId]);
    if (!r.rowCount) throw notFound('push_device_not_found');
    return { ok: true };
  }));

  // Aviso de prueba a todos los dispositivos de la persona (para comprobar que llegan).
  app.post('/api/push/test', { config: { rateLimit: { max: process.env.NODE_ENV === 'test' ? 10_000 : 10, timeWindow: '1 minute' } } }, userRoute(async (c) => {
    const u = await c.db.one<{ language: Lang | null; lang: Lang | null }>(
      `SELECT u.language, (SELECT default_language FROM companies WHERE id = $2) AS lang FROM users u WHERE u.id = $1`, [c.userId, c.companyId]);
    const lang: Lang = u.language ?? u.lang ?? 'es';
    const msg = lang === 'es'
      ? { title: 'Notificación de prueba', body: 'Funciona: recibirás avisos así en este dispositivo.' }
      : { title: 'Test notification', body: 'It works: you will get alerts like this on this device.' };
    return pushToUser(c.userId, { ...msg, url: '/notifications', tag: 'test', event: 'test' });
  }));

  // ------------------------------------------------------------ Bandeja
  app.get('/api/notifications', route(null, async (c) => {
    const q = c.query(z.object({ unread: zFlag.default(false), limit: z.coerce.number().int().min(1).max(100).default(30), before: zId.optional() }));
    const rows = await c.db.rows(
      `SELECT id, event, title, body, url, read_at AS "readAt", created_at AS "createdAt" FROM notifications
        WHERE user_id = $1 AND in_app AND ($2::boolean IS FALSE OR read_at IS NULL) AND ($3::bigint IS NULL OR id < $3)
        ORDER BY id DESC LIMIT $4`, [c.userId, q.unread, q.before ?? null, q.limit + 1]);
    const unreadCount = (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND in_app AND read_at IS NULL', [c.userId])).n;
    return { items: rows.slice(0, q.limit), hasMore: rows.length > q.limit, unreadCount };
  }));

  app.get('/api/notifications/unread-count', route(null, async (c) =>
    ({ count: (await c.db.one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND in_app AND read_at IS NULL', [c.userId])).n })));

  app.post('/api/notifications/read', route(null, async (c) => {
    const b = c.body(z.object({ ids: z.array(zId).max(500).optional(), all: z.boolean().optional() }));
    if (!b.all && !b.ids?.length) throw badRequest('nothing_selected');
    const r = await c.db.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::bigint[]))`,
      [c.userId, !!b.all, b.ids ?? []]);
    return { updated: r.rowCount ?? 0 };
  }));

  app.delete('/api/notifications/:id', route(null, async (c) => {
    const { id } = c.params(zIdParam);
    const r = await c.db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, c.userId]);
    if (!r.rowCount) throw notFound('notification_not_found');
    return { ok: true };
  }));

  /** Vacía la bandeja: solo los ya leídos, salvo que se pida todo. */
  app.delete('/api/notifications', route(null, async (c) => {
    const { all } = c.query(z.object({ all: zFlag.default(false) }));
    const r = await c.db.query('DELETE FROM notifications WHERE user_id = $1 AND in_app AND ($2::boolean OR read_at IS NOT NULL)', [c.userId, all]);
    return { deleted: r.rowCount ?? 0 };
  }));

  // ------------------------------------------------------------ Preferencias
  app.get('/api/notifications/prefs', route(null, async (c) => {
    const saved = await c.db.rows<{ event: string; in_app: boolean; push: boolean }>('SELECT event, in_app, push FROM notification_prefs WHERE user_id = $1', [c.userId]);
    const map = new Map(saved.map((s) => [s.event, s]));
    return {
      events: eventsFor(c.can).map((key) => ({ key, inApp: map.get(key)?.in_app ?? true, push: map.get(key)?.push ?? true })),
    };
  }));

  app.put('/api/notifications/prefs', route(null, async (c) => {
    const b = c.body(z.object({ prefs: z.array(z.object({ event: z.string(), inApp: z.boolean(), push: z.boolean() })).max(50) }));
    const allowed = new Set<string>(eventsFor(c.can));
    for (const p of b.prefs) {
      if (!isEventKey(p.event) || !allowed.has(p.event)) throw badRequest('invalid_event', { event: p.event });
      if (p.inApp && p.push) {
        await c.db.query('DELETE FROM notification_prefs WHERE company_id = $1 AND user_id = $2 AND event = $3', [c.companyId, c.userId, p.event]);   // lo normal no se guarda
      } else {
        await c.db.query(
          `INSERT INTO notification_prefs (company_id, user_id, event, in_app, push) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (company_id, user_id, event) DO UPDATE SET in_app = EXCLUDED.in_app, push = EXCLUDED.push`,
          [c.companyId, c.userId, p.event, p.inApp, p.push]);
      }
    }
    return { ok: true };
  }));
}
