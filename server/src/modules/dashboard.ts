import type { FastifyInstance } from 'fastify';
import { route } from '../http.js';
import { ownOrdersFilter } from '../services/salesScope.js';

/**
 * Panel principal. Cada bloque de datos solo se calcula y se envía si el usuario tiene el permiso
 * de la información correspondiente (inventario, lotes, ventas, ubicaciones...), de modo que el panel
 * muestra únicamente lo que esa persona puede ver.
 */
export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/api/dashboard', route('dashboard.view', async (c) => {
    const out: Record<string, unknown> = {};

    // ------------------------------------------------ Inventario (equipos)
    if (c.can('units.view')) {
      const unitsByStatus = await c.db.rows(`SELECT u.status_id AS "statusId", count(*)::int AS n FROM units u GROUP BY u.status_id`);
      const unitsByType = await c.db.rows(
        `SELECT u.equipment_type_id AS "typeId", st.system_key AS "statusKey", count(*)::int AS n
           FROM units u JOIN catalog_items st ON st.id = u.status_id GROUP BY 1, 2`);
      const stock = `JOIN catalog_items st ON st.id = u.status_id WHERE st.system_key IN ('available', 'reserved', 'not_sellable')`;
      const byCosmetic = await c.db.rows(`SELECT u.cosmetic_grade_id AS "gradeId", count(*)::int AS n FROM units u ${stock} GROUP BY 1`);
      const byFunctional = await c.db.rows(`SELECT u.functional_grade_id AS "gradeId", count(*)::int AS n FROM units u ${stock} GROUP BY 1`);
      const aging = await c.db.one<{ d30: number; d60: number; d90: number; d90p: number }>(
        `SELECT count(*) FILTER (WHERE age <= 30)::int AS d30, count(*) FILTER (WHERE age > 30 AND age <= 60)::int AS d60,
                count(*) FILTER (WHERE age > 60 AND age <= 90)::int AS d90, count(*) FILTER (WHERE age > 90)::int AS d90p
           FROM (SELECT (current_date - COALESCE(u.tested_at, u.created_at)::date) AS age FROM units u
                   JOIN catalog_items st ON st.id = u.status_id WHERE st.system_key IN ('available', 'not_sellable')) x`);
      const testedToday = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM units WHERE tested_at >= date_trunc('day', now())`)).n;
      const testedByDay = await c.db.rows(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.n, 0)::int AS n
           FROM generate_series(current_date - 13, current_date, interval '1 day') d
           LEFT JOIN (SELECT tested_at::date AS day, count(*) AS n FROM units WHERE tested_at >= current_date - 13 GROUP BY 1) x ON x.day = d::date
          ORDER BY d`);
      const testedByTech = await c.db.rows(
        `SELECT us.full_name AS name, m.tech_number AS "techNumber", count(*)::int AS n
           FROM units u JOIN memberships m ON m.id = u.tester_membership_id JOIN users us ON us.id = m.user_id
          WHERE u.tested_at >= current_date - 29 GROUP BY 1, 2 ORDER BY n DESC LIMIT 8`);
      out.inventory = { unitsByStatus, unitsByType, byCosmetic, byFunctional, aging, testedToday, testedByDay, testedByTech };
    }

    // ------------------------------------------------ Mi actividad de testeo
    if (c.can('units.test')) {
      const mine = await c.db.rows(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.n, 0)::int AS n
           FROM generate_series(current_date - 13, current_date, interval '1 day') d
           LEFT JOIN (SELECT tested_at::date AS day, count(*) AS n FROM units WHERE tester_membership_id = $1 AND tested_at >= current_date - 13 GROUP BY 1) x ON x.day = d::date
          ORDER BY d`, [c.membershipId]);
      const inTesting = (await c.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.tester_membership_id = $1 AND st.system_key = 'testing'`, [c.membershipId])).n;
      out.mine = { testedByDay: mine, inTesting };
    }

    // ------------------------------------------------ Ubicaciones
    if (c.can('locations.view')) {
      const toPlace = (await c.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM units u JOIN catalog_items st ON st.id = u.status_id
          WHERE u.slot_id IS NULL AND st.system_key IN ('available', 'not_sellable', 'reserved')`)).n;
      const occupancy = await c.db.rows(
        `SELECT w.id, w.code, w.name, COALESCE(sum(s.capacity), 0)::int AS capacity, COALESCE(sum(uc.n), 0)::int AS used
           FROM warehouses w JOIN areas a ON a.warehouse_id = w.id JOIN racks r ON r.area_id = a.id JOIN slots s ON s.rack_id = r.id AND s.is_active
           LEFT JOIN (SELECT slot_id, count(*) AS n FROM units WHERE slot_id IS NOT NULL GROUP BY 1) uc ON uc.slot_id = s.id
          WHERE w.is_active GROUP BY w.id ORDER BY w.code`);
      out.locations = { toPlace, occupancy };
    }

    // ------------------------------------------------ Lotes
    if (c.can('lots.view')) {
      const lotsByStatus = await c.db.rows(`SELECT l.status_id AS "statusId", count(*)::int AS n FROM lots l GROUP BY l.status_id`);
      const openLots = await c.db.rows(
        `SELECT l.id, l.code, ci.system_key AS "statusKey",
                (SELECT COALESCE(sum(counted_qty), 0) FROM lot_lines WHERE lot_id = l.id)::int AS counted,
                (SELECT count(*) FROM units WHERE lot_id = l.id)::int AS units,
                (SELECT count(*) FROM units u JOIN catalog_items st ON st.id = u.status_id WHERE u.lot_id = l.id AND st.system_key = 'testing')::int AS "inTesting"
           FROM lots l JOIN catalog_items ci ON ci.id = l.status_id WHERE ci.system_key <> 'closed' ORDER BY l.id DESC LIMIT 8`);
      const receivedByMonth = await c.db.rows(
        `SELECT to_char(date_trunc('month', l.purchase_date), 'YYYY-MM') AS month, count(*)::int AS lots,
                COALESCE(sum((SELECT COALESCE(sum(counted_qty), 0) FROM lot_lines WHERE lot_id = l.id)), 0)::int AS units
           FROM lots l WHERE l.purchase_date >= (date_trunc('month', current_date) - interval '5 months') GROUP BY 1 ORDER BY 1`);
      out.lots = { lotsByStatus, openLots, receivedByMonth };
    }

    // ------------------------------------------------ Ventas
    if (c.can('sales.view')) {
      // Sin "ver las ventas de todos", todas las cifras de esta sección son solo de sus propios pedidos.
      const own = ownOrdersFilter(c);
      const and = own ? ` AND ${own}` : '';
      const openOrders = await c.db.rows(
        `SELECT o.id, o.code, cu.name AS "customerName", o.reserved_until AS "reservedUntil",
                (SELECT count(*) FROM sale_items WHERE order_id = o.id AND released_at IS NULL)::int AS "itemCount",
                (SELECT COALESCE(sum(quantity), 0) FROM order_lines WHERE order_id = o.id)::int AS requested
           FROM sales_orders o JOIN customers cu ON cu.id = o.customer_id JOIN catalog_items st ON st.id = o.status_id
          WHERE st.system_key = 'open'${and} ORDER BY o.created_at DESC LIMIT 8`);
      const openCount = (await c.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id WHERE st.system_key = 'open'${and}`)).n;
      const ordersByStatus = await c.db.rows(`SELECT o.status_id AS "statusId", count(*)::int AS n FROM sales_orders o ${own ? `WHERE ${own} ` : ''}GROUP BY 1`);
      const soldMonth = (await c.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM sale_items si JOIN sales_orders o ON o.id = si.order_id JOIN catalog_items st ON st.id = o.status_id
          WHERE st.system_key = 'completed' AND si.released_at IS NULL AND o.completed_at >= date_trunc('month', now())${and}`)).n;
      const soldByDay = await c.db.rows(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(x.n, 0)::int AS n
           FROM generate_series(current_date - 29, current_date, interval '1 day') d
           LEFT JOIN (SELECT o.completed_at::date AS day, count(*) AS n FROM sale_items si JOIN sales_orders o ON o.id = si.order_id
                       JOIN catalog_items st ON st.id = o.status_id
                      WHERE st.system_key = 'completed' AND si.released_at IS NULL AND o.completed_at >= current_date - 29${and} GROUP BY 1) x ON x.day = d::date
          ORDER BY d`);
      const topCustomers = await c.db.rows(
        `SELECT cu.name, count(*)::int AS n FROM sale_items si JOIN sales_orders o ON o.id = si.order_id JOIN customers cu ON cu.id = o.customer_id
           JOIN catalog_items st ON st.id = o.status_id
          WHERE st.system_key = 'completed' AND si.released_at IS NULL AND o.completed_at >= current_date - 89${and} GROUP BY 1 ORDER BY n DESC LIMIT 6`);
      // Dinero: solo con permiso de ver precios
      const revenueByMonth = c.can('sales.price')
        ? await c.db.rows(
          `SELECT to_char(date_trunc('month', o.completed_at), 'YYYY-MM') AS month, o.currency, COALESCE(sum(si.unit_price), 0)::float AS total
             FROM sale_items si JOIN sales_orders o ON o.id = si.order_id JOIN catalog_items st ON st.id = o.status_id
            WHERE st.system_key = 'completed' AND si.released_at IS NULL AND o.completed_at >= (date_trunc('month', current_date) - interval '5 months')${and}
            GROUP BY 1, 2 ORDER BY 1`)
        : null;
      // Si quien mira es vendedor, sus propias cifras
      const seller = await c.db.opt<{ id: number }>('SELECT id FROM sellers WHERE membership_id = $1', [c.membershipId]);
      const mine = seller
        ? await c.db.one<{ open: number; units: number }>(
          `SELECT (SELECT count(*) FROM sales_orders o JOIN catalog_items st ON st.id = o.status_id WHERE o.seller_id = $1 AND st.system_key = 'open')::int AS open,
                  (SELECT count(*) FROM sale_items si JOIN sales_orders o ON o.id = si.order_id JOIN catalog_items st ON st.id = o.status_id
                    WHERE o.seller_id = $1 AND st.system_key = 'completed' AND si.released_at IS NULL AND o.completed_at >= date_trunc('month', now()))::int AS units`, [seller.id])
        : null;
      out.sales = { openOrders, openCount, ordersByStatus, soldMonth, soldByDay, topCustomers, revenueByMonth, mine };
    }

    // ------------------------------------------------ Actividad reciente
    if (c.can('audit.view')) {
      out.recent = await c.db.rows(
        `SELECT a.id, a.at, a.action, a.entity, a.entity_id AS "entityId", a.data, u.full_name AS "userName"
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 12`);
    }
    return out;
  }));
}
