import type { FastifyBaseLogger } from 'fastify';
import { withGlobal, withTenant, type Db } from '../db.js';
import { releaseItems } from '../modules/sales.js';
import { sysItemId } from './common.js';
import { notifyEvent } from './notifications.js';

/** Horas de anticipación con que se avisa que una reserva está por vencer. */
export const EXPIRY_WARNING_HOURS = 24;

/** Libera las reservas vencidas: los equipos vuelven a estar disponibles y el pedido queda cancelado. */
export async function releaseExpiredReservations(log: FastifyBaseLogger): Promise<number> {
  const companies = await withGlobal((db) => db.rows<{ id: number }>('SELECT id FROM companies WHERE is_active'));
  let total = 0;
  for (const co of companies) {
    try {
      total += await withTenant(co.id, async (db) => {
        const expired = await db.rows<{ id: number; code: string; created_by: number | null }>(
          `SELECT o.id, o.code, o.created_by FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id
            WHERE st.system_key = 'open' AND o.reserved_until IS NOT NULL AND o.reserved_until < now() FOR UPDATE OF o SKIP LOCKED`);
        await warnExpiring(db, co.id);
        if (!expired.length) return 0;
        const cancelled = await sysItemId(db, 'order_status', 'cancelled');
        const audit = async (action: string, entity: string, entityId: number | null, data: Record<string, unknown> = {}) => {
          await db.query('INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, data) VALUES ($1, NULL, $2, $3, $4, $5)',
            [co.id, action, entity, entityId, JSON.stringify(data)]);
        };
        for (const o of expired) {
          const items = await db.rows<{ id: number }>('SELECT id FROM sale_items WHERE order_id = $1 AND released_at IS NULL', [o.id]);
          await releaseItems({ db, audit }, items.map((i) => i.id), 'reservation_expired');
          await db.query('UPDATE sales_orders SET status_id = $2, cancelled_at = now(), reserved_until = NULL WHERE id = $1', [o.id, cancelled]);
          await audit('order.expired', 'order', o.id, { code: o.code });
          await notifyEvent(db, co.id, 'order_expired', { id: o.id, code: o.code }, { alsoUserIds: [o.created_by], orderId: o.id });
        }
        return expired.length;
      });
    } catch (err) {
      log.error({ err, companyId: co.id }, 'error liberando reservas vencidas');
    }
  }
  return total;
}

export function startSweeper(log: FastifyBaseLogger, everyMs = 5 * 60_000): () => void {
  const tick = () => releaseExpiredReservations(log).then((n) => { if (n) log.info(`Reservas vencidas liberadas: ${n}`); }).catch((err) => log.error({ err }, 'sweeper'));
  const t = setInterval(tick, everyMs);
  t.unref();
  setTimeout(tick, 10_000).unref();
  return () => clearInterval(t);
}

/** Avisa (una sola vez por reserva) de los pedidos abiertos que vencen dentro de las próximas horas. */
async function warnExpiring(db: Db, companyId: number): Promise<void> {
  const soon = await db.rows<{ id: number; code: string; created_by: number | null; reserved_until: Date }>(
    `SELECT o.id, o.code, o.created_by, o.reserved_until FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id
      WHERE st.system_key = 'open' AND o.reserved_until IS NOT NULL AND o.reserved_until > now()
        AND o.reserved_until < now() + make_interval(hours => $1) AND o.expiry_notified_at IS NULL FOR UPDATE OF o SKIP LOCKED`, [EXPIRY_WARNING_HOURS]);
  if (!soon.length) return;
  const co = await db.one<{ timezone: string }>('SELECT timezone FROM companies WHERE id = $1', [companyId]);
  for (const o of soon) {
    await db.query('UPDATE sales_orders SET expiry_notified_at = now() WHERE id = $1', [o.id]);
    // La fecha se formatea en el idioma de cada destinatario al armar el texto.
    await notifyEvent(db, companyId, 'order_expiring', { id: o.id, code: o.code, when: o.reserved_until.toISOString(), tz: co.timezone }, { alsoUserIds: [o.created_by], orderId: o.id });
  }
}
