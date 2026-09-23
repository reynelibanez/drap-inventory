import type { FastifyBaseLogger } from 'fastify';
import { withGlobal, withTenant, type Db } from '../db.js';
import { sendPush, type PushMessage } from './webpush.js';

/**
 * Avisos del sistema. Cada aviso se guarda en la bandeja de cada persona que debe recibirlo y, si tiene
 * el push activado, se envía a sus dispositivos (aunque la app esté cerrada).
 *
 * Los avisos se crean DENTRO de la transacción de la acción que los origina (si esa acción se revierte, el
 * aviso también) y un despachador los envía poco después, ya confirmados.
 */

export type Lang = 'es' | 'en';

interface EventDef {
  /** Quién lo recibe: personas con AL MENOS uno de estos permisos (los administradores siempre). */
  perms: string[];
  /** Permisos adicionales que hacen que el aviso aparezca en sus preferencias (por ejemplo, quien crea pedidos). */
  alsoVisibleTo?: string[];
  /** Texto (título y detalle) en cada idioma. */
  text: Record<Lang, (p: Params) => { title: string; body?: string }>;
  url: (p: Params) => string;
}

export type Params = Record<string, string | number | null | undefined>;

/** Fecha de vencimiento (ISO en `when`) en el idioma y la zona horaria de la empresa (`tz`). */
const when = (p: Params, lang: Lang) => formatWhen(new Date(String(p.when)), lang, String(p.tz ?? 'UTC'));

const EVENTS = {
  lot_counted: {
    perms: ['lots.close'],
    text: {
      es: (p) => ({ title: `Conteo terminado: ${p.code}`, body: 'El lote está listo para pasar a testeo.' }),
      en: (p) => ({ title: `Count finished: ${p.code}`, body: 'The lot is ready to move to testing.' }),
    },
    url: (p) => `/lots/${p.id}`,
  },
  lot_testing: {
    perms: ['units.test'],
    text: {
      es: (p) => ({ title: `Lote ${p.code} listo para testear`, body: 'Ya se pueden registrar y testear sus equipos.' }),
      en: (p) => ({ title: `Lot ${p.code} ready for testing`, body: 'Its units can now be registered and tested.' }),
    },
    url: (p) => `/testing?lot=${p.id}`,
  },
  order_created: {
    perms: ['sales.complete'],
    text: {
      es: (p) => ({ title: `Nuevo pedido ${p.code}`, body: p.customer ? `Cliente: ${p.customer}` : undefined }),
      en: (p) => ({ title: `New order ${p.code}`, body: p.customer ? `Customer: ${p.customer}` : undefined }),
    },
    url: (p) => `/orders/${p.id}`,
  },
  order_completed: {
    perms: ['sales.view'],
    text: {
      es: (p) => ({ title: `Venta completada: ${p.code}`, body: [p.customer, `${p.items} equipo(s)`].filter(Boolean).join(' · ') }),
      en: (p) => ({ title: `Sale completed: ${p.code}`, body: [p.customer, `${p.items} unit(s)`].filter(Boolean).join(' · ') }),
    },
    url: (p) => `/orders/${p.id}`,
  },
  order_cancelled: {
    perms: ['sales.cancel'],
    alsoVisibleTo: ['sales.create'],
    text: {
      es: (p) => ({ title: `Pedido cancelado: ${p.code}`, body: 'Sus equipos volvieron a estar disponibles.' }),
      en: (p) => ({ title: `Order cancelled: ${p.code}`, body: 'Its units are available again.' }),
    },
    url: (p) => `/orders/${p.id}`,
  },
  order_expiring: {
    perms: ['sales.cancel'],
    alsoVisibleTo: ['sales.create'],
    text: {
      es: (p) => ({ title: `La reserva de ${p.code} vence pronto`, body: `Vence el ${when(p, 'es')}. Complétala o cambia la fecha.` }),
      en: (p) => ({ title: `Reservation ${p.code} expires soon`, body: `Expires ${when(p, 'en')}. Complete it or change the date.` }),
    },
    url: (p) => `/orders/${p.id}`,
  },
  order_expired: {
    perms: ['sales.cancel'],
    alsoVisibleTo: ['sales.create'],
    text: {
      es: (p) => ({ title: `Reserva vencida: ${p.code}`, body: 'El pedido se canceló y sus equipos se liberaron.' }),
      en: (p) => ({ title: `Reservation expired: ${p.code}`, body: 'The order was cancelled and its units were released.' }),
    },
    url: (p) => `/orders/${p.id}`,
  },
} satisfies Record<string, EventDef>;

export type EventKey = keyof typeof EVENTS;
export const EVENT_KEYS = Object.keys(EVENTS) as EventKey[];
export const isEventKey = (k: string): k is EventKey => k in EVENTS;

/** Avisos que una persona puede recibir según sus permisos (para su pantalla de preferencias). */
export function eventsFor(can: (perm: string) => boolean): EventKey[] {
  return EVENT_KEYS.filter((k) => {
    const d = EVENTS[k] as EventDef;
    return [...d.perms, ...(d.alsoVisibleTo ?? [])].some(can);
  });
}

export function renderEvent(event: EventKey, lang: Lang, params: Params) {
  const d = EVENTS[event] as EventDef;
  return { ...d.text[lang](params), url: d.url(params) };
}

/** Fecha corta y legible en la zona horaria de la empresa. */
export function formatWhen(date: Date, lang: Lang, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date);
  } catch {
    return date.toISOString();
  }
}

// ---------------------------------------------------------------------------
// Crear avisos
// ---------------------------------------------------------------------------

/**
 * Crea el aviso para todas las personas de la empresa que corresponda. Devuelve cuántas lo recibirán.
 *  - `actorUserId`: quien hizo la acción no se avisa a sí mismo.
 *  - `alsoUserIds`: personas concretas (por ejemplo quien creó el pedido) aunque no tengan el permiso.
 * Respeta las preferencias de cada persona (bandeja y/o push).
 */
export async function notifyEvent(
  db: Db, companyId: number, event: EventKey, params: Params,
  opts: { actorUserId?: number | null; alsoUserIds?: (number | null | undefined)[]; orderId?: number } = {},
): Promise<number> {
  const def = EVENTS[event] as EventDef;
  const alsoList = [...(opts.alsoUserIds ?? [])];
  // Aviso de un pedido: solo lo reciben sus dueños (quien lo creó y su vendedor) y quienes pueden ver las ventas de todos.
  if (opts.orderId) {
    const o = await db.opt<{ created_by: number | null; seller_user: number | null }>(
      `SELECT o.created_by, (SELECT m.user_id FROM sellers se JOIN memberships m ON m.id = se.membership_id WHERE se.id = o.seller_id) AS seller_user
         FROM sales_orders o WHERE o.id = $1`, [opts.orderId]);
    if (o) alsoList.push(o.created_by, o.seller_user);
  }
  const also = [...new Set(alsoList.filter((x): x is number => typeof x === 'number'))];
  const company = await db.one<{ name: string; default_language: Lang }>('SELECT name, default_language FROM companies WHERE id = $1', [companyId]);

  const people = await db.rows<{ user_id: number; language: Lang | null; companies: number; in_app: boolean | null; push: boolean | null }>(
    `SELECT m.user_id, u.language,
            (SELECT count(*)::int FROM memberships m2 JOIN companies c2 ON c2.id = m2.company_id AND c2.is_active WHERE m2.user_id = u.id AND m2.is_active) AS companies,
            np.in_app, np.push
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.is_active
       LEFT JOIN notification_prefs np ON np.company_id = m.company_id AND np.user_id = m.user_id AND np.event = $3
      WHERE m.company_id = $1 AND m.is_active
        AND ($4::bigint IS NULL OR m.user_id <> $4)
        AND (
          m.user_id = ANY($5::bigint[])
          OR m.is_company_admin
          OR (EXISTS (
            SELECT 1 FROM unnest($2::text[]) AS k(key)
             WHERE (EXISTS (SELECT 1 FROM membership_roles mr JOIN roles r ON r.id = mr.role_id AND r.is_active
                              JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
                             WHERE mr.membership_id = m.id AND p.key = k.key)
                    OR EXISTS (SELECT 1 FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id
                                WHERE mp.membership_id = m.id AND mp.effect = 'allow' AND p.key = k.key))
               AND NOT EXISTS (SELECT 1 FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id
                                WHERE mp.membership_id = m.id AND mp.effect = 'deny' AND p.key = k.key)
          )
          AND (NOT $6::boolean OR (
            (EXISTS (SELECT 1 FROM membership_roles mr JOIN roles r ON r.id = mr.role_id AND r.is_active
                       JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id
                      WHERE mr.membership_id = m.id AND p.key = 'sales.view_all')
             OR EXISTS (SELECT 1 FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id
                         WHERE mp.membership_id = m.id AND mp.effect = 'allow' AND p.key = 'sales.view_all'))
            AND NOT EXISTS (SELECT 1 FROM membership_permissions mp JOIN permissions p ON p.id = mp.permission_id
                             WHERE mp.membership_id = m.id AND mp.effect = 'deny' AND p.key = 'sales.view_all'))))
        )`,
    [companyId, def.perms, event, opts.actorUserId ?? null, also, !!opts.orderId]);

  let n = 0;
  for (const p of people) {
    const inApp = p.in_app ?? true, push = p.push ?? true;
    if (!inApp && !push) continue;
    const r = renderEvent(event, p.language ?? company.default_language, params);
    // Quien está en varias empresas ve de cuál es el aviso.
    const body = [r.body, p.companies > 1 ? company.name : ''].filter(Boolean).join(' · ') || null;
    await db.query(
      `INSERT INTO notifications (company_id, user_id, event, title, body, url, in_app, push_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, p.user_id, event, r.title, body, r.url, inApp, push ? 'pending' : 'skipped']);
    n++;
  }
  if (n) kickPushDispatcher();
  return n;
}

// ---------------------------------------------------------------------------
// Envío push
// ---------------------------------------------------------------------------

/** Envía un mensaje a todos los dispositivos de una persona. Devuelve cuántos lo recibieron y cuántos fallaron. */
export async function pushToUser(userId: number, msg: PushMessage): Promise<{ devices: number; sent: number; failed: number }> {
  const subs = await withGlobal((db) => db.rows<{ id: number; endpoint: string; p256dh: string; auth: string; failures: number }>(
    'SELECT id, endpoint, p256dh, auth, failures FROM push_subscriptions WHERE user_id = $1 ORDER BY id', [userId]));
  if (!subs.length) return { devices: 0, sent: 0, failed: 0 };
  const results = await Promise.all(subs.map((s) => sendPush(s, msg)));
  const ok = subs.filter((_, i) => results[i] === 'sent').map((s) => s.id);
  const gone = subs.filter((_, i) => results[i] === 'gone').map((s) => s.id);
  const bad = subs.filter((s, i) => results[i] === 'failed' && s.failures + 1 >= 8).map((s) => s.id);   // 8 fallos seguidos: el dispositivo ya no existe
  const failedIds = subs.filter((_, i) => results[i] === 'failed').map((s) => s.id);
  await withGlobal(async (db) => {
    if (ok.length) await db.query('UPDATE push_subscriptions SET failures = 0, last_used_at = now() WHERE id = ANY($1::bigint[])', [ok]);
    if (failedIds.length) await db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ANY($1::bigint[])', [failedIds]);
    if (gone.length || bad.length) await db.query('DELETE FROM push_subscriptions WHERE id = ANY($1::bigint[])', [[...gone, ...bad]]);
  });
  return { devices: subs.length, sent: ok.length, failed: subs.length - ok.length };
}

/** Envía los avisos pendientes de todas las empresas. Devuelve cuántos procesó. */
export async function flushPendingPushes(log?: FastifyBaseLogger): Promise<number> {
  const companies = await withGlobal((db) => db.rows<{ id: number }>('SELECT id FROM companies WHERE is_active'));
  let total = 0;
  for (const co of companies) {
    try {
      total += await withTenant(co.id, async (db) => {
        const rows = await db.rows<{ id: number; user_id: number; event: string; title: string; body: string | null; url: string | null }>(
          `SELECT id, user_id, event, title, body, url FROM notifications WHERE push_state = 'pending' ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
        for (const r of rows) {
          const res = await pushToUser(r.user_id, { title: r.title, body: r.body ?? undefined, url: r.url ?? '/', tag: `${r.event}-${r.id}`, event: r.event, id: r.id });
          const state = res.devices === 0 ? 'skipped' : res.sent > 0 ? 'sent' : 'failed';
          await db.query('UPDATE notifications SET push_state = $2 WHERE id = $1', [r.id, state]);
        }
        return rows.length;
      });
    } catch (err) {
      log?.error({ err, companyId: co.id }, 'error enviando notificaciones push');
    }
  }
  return total;
}

/** Borra avisos leídos con más de 30 días y cualquiera con más de 90. */
export async function pruneNotifications(): Promise<void> {
  const companies = await withGlobal((db) => db.rows<{ id: number }>('SELECT id FROM companies'));
  for (const co of companies) {
    await withTenant(co.id, (db) => db.query(
      `DELETE FROM notifications WHERE created_at < now() - interval '90 days' OR (read_at IS NOT NULL AND created_at < now() - interval '30 days')`));
  }
}

let kickTimer: NodeJS.Timeout | null = null;
let dispatcherLog: FastifyBaseLogger | undefined;

/** Pide un envío pronto (agrupa varios avisos seguidos y da tiempo a que la transacción se confirme). */
export function kickPushDispatcher(delayMs = 1500) {
  if (kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    flushPendingPushes(dispatcherLog).catch((err) => dispatcherLog?.error({ err }, 'push dispatcher'));
  }, delayMs);
  kickTimer.unref();
}

/** Revisa cada 30 s si quedó algo pendiente (por si el servidor se reinició) y limpia avisos viejos una vez al día. */
export function startPushDispatcher(log: FastifyBaseLogger): () => void {
  dispatcherLog = log;
  const tick = setInterval(() => { flushPendingPushes(log).catch((err) => log.error({ err }, 'push dispatcher')); }, 30_000);
  const prune = setInterval(() => { pruneNotifications().catch((err) => log.error({ err }, 'prune notifications')); }, 24 * 3600_000);
  tick.unref(); prune.unref();
  setTimeout(() => { flushPendingPushes(log).catch(() => undefined); }, 5_000).unref();
  return () => { clearInterval(tick); clearInterval(prune); };
}
