import type { Db } from '../db.js';
import type { Ctx } from '../http.js';
import { notFound } from '../errors.js';

/**
 * "Solo mis ventas": quien NO tiene el permiso `sales.view_all` ve únicamente los pedidos/ventas propios.
 * Un pedido es "mío" si lo creé yo, o si yo soy el vendedor asignado (vendedor ligado a mi usuario).
 * Los administradores de la empresa siempre ven todo. Se activa o desactiva por rol, o por usuario en sus excepciones.
 */
export const seesAllSales = (c: Pick<Ctx, 'can'>) => c.can('sales.view_all');

/**
 * Condición SQL "este pedido es mío" para el alias de sales_orders indicado.
 * Los números salen de la sesión (no del usuario) y se convierten a entero: es seguro escribirlos en el SQL.
 */
export function mineOrderSql(c: Pick<Ctx, 'userId' | 'membershipId'>, alias = 'o'): string {
  const u = Math.trunc(Number(c.userId));
  const m = Math.trunc(Number(c.membershipId));
  return `(${alias}.created_by = ${u} OR ${alias}.seller_id IN (SELECT id FROM sellers WHERE membership_id = ${m}))`;
}

/** Condición para agregar al WHERE de un listado de pedidos: '' si el usuario ve todo. */
export function ownOrdersFilter(c: Ctx, alias = 'o'): string {
  return seesAllSales(c) ? '' : mineOrderSql(c, alias);
}

/** Lanza "pedido no encontrado" (404, para no revelar que existe) si el pedido es de otro y el usuario solo ve los suyos. */
export async function assertOrderVisible(c: Ctx, orderId: number): Promise<void> {
  if (seesAllSales(c)) return;
  const ok = await c.db.opt(`SELECT 1 FROM sales_orders o WHERE o.id = $1 AND ${mineOrderSql(c)}`, [orderId]);
  if (!ok) throw notFound('order_not_found');
}

/**
 * Empresas creadas antes de existir "ver las ventas de todos": una sola vez, todos los roles que ya veían ventas
 * conservan ese acceso, salvo el rol de vendedores de fábrica (Ventas), que pasa a ver solo lo suyo. Idempotente.
 * Después el administrador lo activa o quita por rol o por usuario en Roles y permisos.
 */
export async function ensureSalesScopeDefaults(db: Db, companyId: number): Promise<void> {
  const seeded = await db.opt<{ done: boolean }>(`SELECT COALESCE((settings->'_seeded'->>'sales_scope')::boolean, false) AS done FROM companies WHERE id = $1`, [companyId]);
  if (seeded?.done) return;
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'sales.view_all'
        AND lower(r.name) NOT IN ('ventas', 'sales', 'vendedor', 'vendedores', 'seller', 'sellers')
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'sales.view')
     ON CONFLICT DO NOTHING`);
  await db.query(
    `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || '{"sales_scope": true}'::jsonb) WHERE id = $1`, [companyId]);
}
