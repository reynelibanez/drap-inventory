import type { Db } from '../db.js';
import type { ReportDef } from './reportCatalog.js';

/**
 * Reportes que vienen de fábrica en cada empresa. Son de solo lectura (para personalizarlos se duplican).
 * El nombre y la descripción se traducen en pantalla por `system_key`; aquí solo queda el texto en español de respaldo.
 * Cada usuario ve únicamente los que su permiso le deja ejecutar.
 */
interface SysReport { key: string; name: string; description: string; dataset: string; def: (ids: Ids) => ReportDef }
interface Ids { stock: string[]; available: string[]; completed: string[]; open: string[] }

const col = (field: string, agg?: ReportDef['columns'][number]['agg']) => ({ field, ...(agg ? { agg } : {}) });
const detail = (columns: ReportDef['columns'], filters: ReportDef['filters'] = [], sort: ReportDef['sort'] = []): ReportDef => ({ mode: 'detail', columns, filters, sort });
const summary = (columns: ReportDef['columns'], filters: ReportDef['filters'] = [], sort: ReportDef['sort'] = []): ReportDef => ({ mode: 'summary', columns, filters, sort });

export const SYSTEM_REPORTS: SysReport[] = [
  {
    key: 'inventory_stock', dataset: 'units', name: 'Inventario en existencia', description: 'Equipos disponibles, reservados y no vendibles, con sus características y ubicación.',
    def: (i) => detail(
      [col('code'), col('type'), col('attr:brand'), col('attr:model'), col('attr:processor'), col('attr:ram'), col('attr:storage_size'), col('cosmetic'), col('functional'), col('status'), col('warehouse'), col('slot')],
      [{ field: 'status', op: 'in', list: i.stock }], [{ col: 0, dir: 'asc' }]),
  },
  {
    key: 'stock_by_type_grade', dataset: 'units', name: 'Existencias por tipo y grado', description: 'Cuántos equipos disponibles hay de cada tipo, grado cosmético y grado funcional.',
    def: (i) => summary([col('type'), col('cosmetic'), col('functional'), col('*', 'count')], [{ field: 'status', op: 'in', list: i.available }]),
  },
  {
    key: 'stock_by_model', dataset: 'units', name: 'Existencias por marca y modelo', description: 'Cantidad de equipos disponibles agrupados por tipo, marca y modelo.',
    def: (i) => summary([col('type'), col('attr:brand'), col('attr:model'), col('*', 'count')], [{ field: 'status', op: 'in', list: i.available }]),
  },
  {
    key: 'stock_by_location', dataset: 'units', name: 'Existencias por ubicación', description: 'Cantidad de equipos en existencia por almacén, área y rack.',
    def: (i) => summary([col('warehouse'), col('area'), col('rack'), col('*', 'count')], [{ field: 'status', op: 'in', list: i.stock }, { field: 'placed', op: 'is', a: 'true' }]),
  },
  {
    key: 'unplaced_units', dataset: 'units', name: 'Equipos sin ubicar', description: 'Equipos en existencia que todavía no tienen un espacio asignado.',
    def: (i) => detail(
      [col('code'), col('type'), col('cosmetic'), col('functional'), col('status'), col('lotCode'), col('testedAt')],
      [{ field: 'status', op: 'in', list: i.stock }, { field: 'placed', op: 'is', a: 'false' }], [{ col: 0, dir: 'asc' }]),
  },
  {
    key: 'tested_by_tech', dataset: 'units', name: 'Testeo por técnico (30 días)', description: 'Equipos testeados por cada técnico en los últimos 30 días.',
    def: () => summary([col('tester'), col('*', 'count'), col('testedAt', 'max')], [{ field: 'testedAt', op: 'lastDays', a: '30' }], [{ col: 1, dir: 'desc' }]),
  },
  {
    key: 'lots_status', dataset: 'lots', name: 'Lotes: esperado, contado y testeado', description: 'Estado de cada lote con cantidades esperadas, contadas, registradas y disponibles.',
    def: () => detail(
      [col('code'), col('status'), col('supplier'), col('purchaseDate'), col('expected'), col('counted'), col('difference'), col('registered'), col('inTesting'), col('available')],
      [], [{ col: 3, dir: 'desc' }]),
  },
  {
    key: 'lot_lines_detail', dataset: 'lot_lines', name: 'Líneas de lote', description: 'Detalle de las líneas de cada lote: tipo, marca, modelo y cantidades.',
    def: () => detail(
      [col('lotCode'), col('lineNo'), col('type'), col('attr:brand'), col('attr:model'), col('expected'), col('counted'), col('difference'), col('registered')],
      [], [{ col: 0, dir: 'desc' }, { col: 1, dir: 'asc' }]),
  },
  {
    key: 'orders_open', dataset: 'orders', name: 'Pedidos abiertos', description: 'Pedidos en curso con cliente, vendedor, vencimiento de la reserva y avance.',
    def: (i) => detail(
      [col('code'), col('customer'), col('seller'), col('createdAt'), col('reservedUntil'), col('requested'), col('units')],
      [{ field: 'status', op: 'in', list: i.open }], [{ col: 3, dir: 'desc' }]),
  },
  {
    key: 'sold_units', dataset: 'order_items', name: 'Equipos vendidos', description: 'Detalle de los equipos de pedidos completados, con cliente y precio (si tienes permiso de precios).',
    def: (i) => detail(
      [col('completedAt'), col('order'), col('customer'), col('unit'), col('type'), col('attr:brand'), col('attr:model'), col('cosmetic'), col('functional'), col('price')],
      [{ field: 'orderStatus', op: 'in', list: i.completed }], [{ col: 0, dir: 'desc' }]),
  },
  {
    key: 'sales_by_customer', dataset: 'order_items', name: 'Ventas por cliente (cantidades)', description: 'Pedidos y equipos vendidos a cada cliente.',
    def: (i) => summary([col('customer'), col('order', 'countDistinct'), col('*', 'count')], [{ field: 'orderStatus', op: 'in', list: i.completed }], [{ col: 2, dir: 'desc' }]),
  },
  {
    key: 'revenue_by_customer', dataset: 'order_items', name: 'Ventas por cliente (importes)', description: 'Total vendido a cada cliente. Solo para quien puede ver precios.',
    def: (i) => summary([col('customer'), col('currency'), col('*', 'count'), col('price', 'sum')], [{ field: 'orderStatus', op: 'in', list: i.completed }], [{ col: 3, dir: 'desc' }]),
  },
  {
    key: 'slot_occupancy', dataset: 'locations', name: 'Ocupación de almacenes', description: 'Capacidad, espacios ocupados y libres por almacén.',
    def: () => summary([col('warehouse'), col('capacity', 'sum'), col('used', 'sum'), col('free', 'sum')], [{ field: 'active', op: 'is', a: 'true' }]),
  },
];

async function catalogIds(db: Db, catalog: string, keys: string[]): Promise<string[]> {
  const rows = await db.rows<{ id: number }>(
    `SELECT ci.id FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id WHERE c.key = $1 AND ci.system_key = ANY($2::text[])`, [catalog, keys]);
  return rows.map((r) => String(r.id));
}

/** Crea los reportes de fábrica que falten. Devuelve cuántos creó. */
export async function seedSystemReports(db: Db, companyId: number): Promise<number> {
  const ids: Ids = {
    stock: await catalogIds(db, 'unit_status', ['available', 'reserved', 'not_sellable']),
    available: await catalogIds(db, 'unit_status', ['available']),
    completed: await catalogIds(db, 'order_status', ['completed']),
    open: await catalogIds(db, 'order_status', ['open']),
  };
  let created = 0;
  for (const r of SYSTEM_REPORTS) {
    const res = await db.query(
      `INSERT INTO reports (company_id, name, description, dataset, definition, visibility, system_key)
       VALUES ($1,$2,$3,$4,$5,'company',$6)
       ON CONFLICT (company_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
      [companyId, r.name, r.description, r.dataset, JSON.stringify(r.def(ids)), r.key]);
    created += res.rowCount ?? 0;
  }
  return created;
}

/**
 * Empresas que ya existían antes de los reportes: da a sus roles los permisos nuevos una sola vez
 * (ver y crear reportes a los roles que hacen algo más que consultar; compartir a quienes gestionan usuarios).
 */
export async function grantReportPermsToExistingRoles(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'reports.view'
     ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'reports.create'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id
                     WHERE rp.role_id = r.id AND x.key NOT LIKE '%.view')
     ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'reports.share'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'users.manage')
     ON CONFLICT DO NOTHING`);
}
