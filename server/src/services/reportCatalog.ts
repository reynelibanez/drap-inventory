import type { Db } from '../db.js';
import { badRequest, forbidden } from '../errors.js';
import { tr } from './describe.js';

/**
 * Catálogo de "conjuntos de datos" que se pueden usar en reportes personalizados y el generador de consultas.
 *
 * Seguridad: todo el SQL sale de este archivo. Lo único que llega del usuario son claves de campo (se buscan en
 * un mapa, nunca se pegan en el SQL) y valores (siempre como parámetros). Cada conjunto y cada campo puede exigir
 * un permiso: nadie puede sacar en un reporte información que no puede ver en el sistema.
 */

export type FType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'select';
export type Agg = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max';
export type Lang = 'es' | 'en';

export interface FieldDef {
  key: string;
  es: string;
  en: string;
  type: FType;
  /** Expresión SQL; `{L}` se reemplaza por el idioma. En campos "select" devuelve el texto visible. */
  sql: string;
  /** Solo "select": expresión con el id (para filtrar). */
  idSql?: string;
  join?: string;
  /** Permiso(s) necesarios para usar el campo (si son varios, hacen falta todos). */
  perm?: string | string[];
  group: string;
  /** Origen de las opciones de un campo "select": types | warehouses | catalog:<clave> | catalogId:<id>. */
  options?: string;
}

interface Join { alias: string; sql: string; deps?: string[] }

export interface Dataset {
  key: string;
  es: string;
  en: string;
  perm: string;
  from: string;
  where?: string;
  /** Condición extra (con {U} = usuario y {M} = membresía de quien ejecuta) para quien no puede ver las ventas de todos: solo lo suyo. */
  ownWhere?: string;
  defaultOrder: string;
  joins: Join[];
  fields: FieldDef[];
  /** Dónde viven los atributos dinámicos (marca, RAM...) de este conjunto. */
  specs?: { sql: string; join?: string };
}

const f = (group: string, key: string, es: string, en: string, type: FType, sql: string, x: Partial<FieldDef> = {}): FieldDef => ({ key, es, en, type, sql, group, ...x });
const permOk = (can: (p: string) => boolean, perm?: string | string[]) => !perm || (Array.isArray(perm) ? perm : [perm]).every(can);
const nm = (a: string) => `COALESCE(${a}.name->>{L}, ${a}.name->>'es')`;

const UNIT_STATS = `LEFT JOIN LATERAL (
  SELECT count(*) AS total,
         count(*) FILTER (WHERE s.system_key = 'testing') AS testing,
         count(*) FILTER (WHERE s.system_key = 'available') AS available,
         count(*) FILTER (WHERE s.system_key = 'reserved') AS reserved,
         count(*) FILTER (WHERE s.system_key = 'sold') AS sold,
         count(*) FILTER (WHERE s.system_key = 'not_sellable') AS not_sellable,
         count(*) FILTER (WHERE im.unit_id IS NOT NULL) AS import_verified,
         count(*) FILTER (WHERE im.unit_id IS NOT NULL AND lower(coalesce(x.serial_number, '')) = lower(coalesce(im.serial_number, '')) AND x.specs = im.specs) AS import_matched
    FROM units x JOIN catalog_items s ON s.id = x.status_id
    LEFT JOIN unit_import_snapshots im ON im.unit_id = x.id
   WHERE x.lot_id = lo.id) us ON true`;

const LOCATION_CHAIN: Join[] = [
  { alias: 'sl', sql: 'LEFT JOIN slots sl ON sl.id = u.slot_id' },
  { alias: 'rk', sql: 'LEFT JOIN racks rk ON rk.id = sl.rack_id', deps: ['sl'] },
  { alias: 'ar', sql: 'LEFT JOIN areas ar ON ar.id = rk.area_id', deps: ['rk'] },
  { alias: 'wh', sql: 'LEFT JOIN warehouses wh ON wh.id = ar.warehouse_id', deps: ['ar'] },
];

const unitCore = (): FieldDef[] => [
  f('unit', 'type', 'Tipo de equipo', 'Equipment type', 'select', nm('et'), { idSql: 'et.id', join: 'et', options: 'types' }),
  f('grades', 'cosmetic', 'Grado cosmético', 'Cosmetic grade', 'select', nm('cg'), { idSql: 'cg.id', join: 'cg', options: 'catalog:cosmetic_grade' }),
  f('grades', 'functional', 'Grado funcional', 'Functional grade', 'select', nm('fg'), { idSql: 'fg.id', join: 'fg', options: 'catalog:functional_grade' }),
];

export const DATASETS: Dataset[] = [
  // ------------------------------------------------------------------ Equipos
  {
    key: 'units', es: 'Equipos (inventario)', en: 'Units (inventory)', perm: 'units.view',
    from: 'units u', defaultOrder: 'u.id DESC',
    specs: { sql: 'u.specs' },
    joins: [
      { alias: 'lo', sql: 'JOIN lots lo ON lo.id = u.lot_id' },
      { alias: 'sp', sql: 'LEFT JOIN suppliers sp ON sp.id = lo.supplier_id', deps: ['lo'] },
      { alias: 'et', sql: 'JOIN equipment_types et ON et.id = u.equipment_type_id' },
      { alias: 'st', sql: 'JOIN catalog_items st ON st.id = u.status_id' },
      { alias: 'cg', sql: 'LEFT JOIN catalog_items cg ON cg.id = u.cosmetic_grade_id' },
      { alias: 'fg', sql: 'LEFT JOIN catalog_items fg ON fg.id = u.functional_grade_id' },
      ...LOCATION_CHAIN,
      { alias: 'tm', sql: 'LEFT JOIN memberships tm ON tm.id = u.tester_membership_id' },
      { alias: 'tu', sql: 'LEFT JOIN users tu ON tu.id = tm.user_id', deps: ['tm'] },
      { alias: 'si', sql: 'LEFT JOIN sale_items si ON si.unit_id = u.id AND si.released_at IS NULL' },
      { alias: 'so', sql: 'LEFT JOIN sales_orders so ON so.id = si.order_id', deps: ['si'] },
      { alias: 'sos', sql: 'LEFT JOIN catalog_items sos ON sos.id = so.status_id', deps: ['so'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = so.customer_id', deps: ['so'] },
      { alias: 'se', sql: 'LEFT JOIN sellers se ON se.id = so.seller_id', deps: ['so'] },
      { alias: 'imp', sql: 'LEFT JOIN unit_import_snapshots imp ON imp.unit_id = u.id' },
    ],
    fields: [
      f('unit', 'code', 'Código', 'Code', 'text', 'u.code'),
      f('unit', 'serial', 'Número de serie', 'Serial number', 'text', 'u.serial_number'),
      ...unitCore(),
      f('unit', 'status', 'Estado', 'Status', 'select', nm('st'), { idSql: 'st.id', join: 'st', options: 'catalog:unit_status' }),
      f('unit', 'notes', 'Notas', 'Notes', 'text', 'u.notes'),
      f('unit', 'createdAt', 'Fecha de registro', 'Registered on', 'datetime', 'u.created_at'),
      f('unit', 'testedAt', 'Fecha de testeo', 'Tested on', 'datetime', 'u.tested_at'),
      f('unit', 'tester', 'Técnico', 'Technician', 'text', 'tu.full_name', { join: 'tu' }),
      f('unit', 'techNumber', 'N.º de técnico', 'Technician no.', 'number', 'u.tester_number'),
      f('unit', 'ageDays', 'Días en inventario', 'Days in stock', 'number', '(current_date - COALESCE(u.tested_at, u.created_at)::date)'),
      f('lot', 'lotCode', 'Lote', 'Lot', 'text', 'lo.code', { join: 'lo' }),
      f('lot', 'lotDate', 'Fecha de compra del lote', 'Lot purchase date', 'date', 'lo.purchase_date', { join: 'lo' }),
      f('lot', 'supplier', 'Proveedor', 'Supplier', 'text', 'sp.name', { join: 'sp', perm: 'suppliers.view' }),
      f('lot', 'hasImportSnapshot', 'Viene de una importación con verificación', 'From an import with verification', 'boolean', '(imp.unit_id IS NOT NULL)', { join: 'imp' }),
      f('lot', 'matchesImportDeclared', 'Llegó igual a lo declarado en la importación', 'Arrived as declared in the import', 'boolean',
        `(CASE WHEN imp.unit_id IS NOT NULL THEN (lower(coalesce(u.serial_number, '')) = lower(coalesce(imp.serial_number, '')) AND u.specs = imp.specs) END)`, { join: 'imp' }),
      f('location', 'placed', 'Está ubicado', 'Is placed', 'boolean', '(u.slot_id IS NOT NULL)'),
      f('location', 'warehouse', 'Almacén', 'Warehouse', 'select', 'wh.name', { idSql: 'wh.id', join: 'wh', options: 'warehouses' }),
      f('location', 'area', 'Área', 'Area', 'text', 'ar.name', { join: 'ar' }),
      f('location', 'rack', 'Rack', 'Rack', 'text', 'rk.code', { join: 'rk' }),
      f('location', 'slot', 'Espacio', 'Slot', 'text', 'sl.code', { join: 'sl' }),
      f('sale', 'order', 'Pedido', 'Order', 'text', 'so.code', { join: 'so', perm: 'sales.view_all' }),
      f('sale', 'orderStatus', 'Estado del pedido', 'Order status', 'select', nm('sos'), { idSql: 'sos.id', join: 'sos', options: 'catalog:order_status', perm: 'sales.view_all' }),
      f('sale', 'customer', 'Cliente', 'Customer', 'text', 'cu.name', { join: 'cu', perm: 'sales.view_all' }),
      f('sale', 'seller', 'Vendedor', 'Seller', 'text', 'se.name', { join: 'se', perm: 'sales.view_all' }),
      f('sale', 'soldAt', 'Fecha de venta', 'Sold on', 'datetime', 'so.completed_at', { join: 'so', perm: 'sales.view_all' }),
      f('sale', 'soldPrice', 'Precio de venta', 'Sale price', 'money', 'si.unit_price', { join: 'si', perm: ['sales.price', 'sales.view_all'] }),
      f('price', 'cost', 'Costo', 'Cost', 'money', 'u.cost', { perm: 'costs.view' }),
      f('price', 'listPrice', 'Precio de lista', 'List price', 'money', 'u.list_price', { perm: 'sales.price' }),
      f('price', 'margin', 'Margen (venta − costo)', 'Margin (sale − cost)', 'money', '(si.unit_price - u.cost)', { join: 'si', perm: ['costs.view', 'sales.view_all'] }),
      f('price', 'marginPct', 'Margen % sobre la venta', 'Margin % of sale', 'number', '(CASE WHEN si.unit_price > 0 THEN round((si.unit_price - u.cost) / si.unit_price * 100, 2) END)', { join: 'si', perm: ['costs.view', 'sales.view_all'] }),
    ],
  },

  // ------------------------------------------------------------------ Lotes
  {
    key: 'lots', es: 'Lotes', en: 'Lots', perm: 'lots.view',
    from: 'lots lo', defaultOrder: 'lo.id DESC',
    joins: [
      { alias: 'st', sql: 'JOIN catalog_items st ON st.id = lo.status_id' },
      { alias: 'sp', sql: 'LEFT JOIN suppliers sp ON sp.id = lo.supplier_id' },
      { alias: 'cb', sql: 'LEFT JOIN users cb ON cb.id = lo.created_by' },
      { alias: 'ls', sql: `LEFT JOIN LATERAL (SELECT count(*) AS lines, COALESCE(sum(expected_qty), 0) AS expected, sum(counted_qty) AS counted FROM lot_lines WHERE lot_id = lo.id) ls ON true` },
      { alias: 'us', sql: UNIT_STATS },
      { alias: 'lx', sql: 'LEFT JOIN LATERAL (SELECT sum(amount) AS total FROM lot_costs WHERE lot_id = lo.id) lx ON true' },
    ],
    fields: [
      f('lot', 'code', 'Código', 'Code', 'text', 'lo.code'),
      f('lot', 'status', 'Estado', 'Status', 'select', nm('st'), { idSql: 'st.id', join: 'st', options: 'catalog:lot_status' }),
      f('lot', 'supplier', 'Proveedor', 'Supplier', 'text', 'sp.name', { join: 'sp', perm: 'suppliers.view' }),
      f('lot', 'purchaseDate', 'Fecha de compra', 'Purchase date', 'date', 'lo.purchase_date'),
      f('lot', 'expectedArrivalDate', 'Fecha de posible entrada', 'Expected arrival date', 'date', 'lo.expected_arrival_date'),
      f('lot', 'reference', 'Referencia', 'Reference', 'text', 'lo.reference'),
      f('lot', 'currency', 'Moneda', 'Currency', 'text', 'lo.currency::text'),
      f('lot', 'totalCost', 'Costo de la mercancía', 'Merchandise cost', 'money', 'lo.total_cost', { perm: 'costs.view' }),
      f('lot', 'extraCosts', 'Costos adicionales', 'Additional costs', 'money', 'COALESCE(lx.total, 0)', { join: 'lx', perm: 'costs.view' }),
      f('lot', 'landedCost', 'Costo total del lote', 'Total lot cost', 'money', '(COALESCE(lo.total_cost, 0) + COALESCE(lx.total, 0))', { join: 'lx', perm: 'costs.view' }),
      f('lot', 'notes', 'Notas', 'Notes', 'text', 'lo.notes'),
      f('lot', 'createdBy', 'Creado por', 'Created by', 'text', 'cb.full_name', { join: 'cb' }),
      f('lot', 'createdAt', 'Fecha de registro', 'Registered on', 'datetime', 'lo.created_at'),
      f('lot', 'countedAt', 'Fecha de conteo', 'Counted on', 'datetime', 'lo.counted_at'),
      f('lot', 'closedAt', 'Fecha de cierre', 'Closed on', 'datetime', 'lo.closed_at'),
      f('stats', 'lines', 'Líneas', 'Lines', 'number', 'ls.lines', { join: 'ls' }),
      f('stats', 'expected', 'Cantidad esperada', 'Expected quantity', 'number', 'ls.expected', { join: 'ls' }),
      f('stats', 'counted', 'Cantidad contada', 'Counted quantity', 'number', 'ls.counted', { join: 'ls' }),
      f('stats', 'difference', 'Diferencia (contado − esperado)', 'Difference (counted − expected)', 'number', '(ls.counted - ls.expected)', { join: 'ls' }),
      f('stats', 'registered', 'Equipos registrados', 'Registered units', 'number', 'us.total', { join: 'us' }),
      f('stats', 'inTesting', 'En testeo', 'In testing', 'number', 'us.testing', { join: 'us' }),
      f('stats', 'available', 'Disponibles', 'Available', 'number', 'us.available', { join: 'us' }),
      f('stats', 'reserved', 'Reservados', 'Reserved', 'number', 'us.reserved', { join: 'us' }),
      f('stats', 'sold', 'Vendidos', 'Sold', 'number', 'us.sold', { join: 'us' }),
      f('stats', 'notSellable', 'No vendibles', 'Not sellable', 'number', 'us.not_sellable', { join: 'us' }),
      f('stats', 'importVerified', 'Con verificación de importación', 'With import verification', 'number', 'us.import_verified', { join: 'us' }),
      f('stats', 'importMatched', 'Llegaron igual a lo declarado', 'Arrived as declared', 'number', 'us.import_matched', { join: 'us' }),
      f('stats', 'importDiffering', 'Con diferencias frente a lo declarado', 'Differing from declared', 'number', '(us.import_verified - us.import_matched)', { join: 'us' }),
    ],
  },

  // ------------------------------------------------------------------ Líneas de lote
  {
    key: 'lot_lines', es: 'Líneas de lote', en: 'Lot lines', perm: 'lots.view',
    from: 'lot_lines ll', defaultOrder: 'll.lot_id DESC, ll.line_no',
    specs: { sql: 'll.specs' },
    joins: [
      { alias: 'lo', sql: 'JOIN lots lo ON lo.id = ll.lot_id' },
      { alias: 'lst', sql: 'JOIN catalog_items lst ON lst.id = lo.status_id', deps: ['lo'] },
      { alias: 'sp', sql: 'LEFT JOIN suppliers sp ON sp.id = lo.supplier_id', deps: ['lo'] },
      { alias: 'et', sql: 'JOIN equipment_types et ON et.id = ll.equipment_type_id' },
      { alias: 'ru', sql: 'LEFT JOIN LATERAL (SELECT count(*) AS n FROM units WHERE lot_line_id = ll.id) ru ON true' },
    ],
    fields: [
      f('lot', 'lotCode', 'Lote', 'Lot', 'text', 'lo.code', { join: 'lo' }),
      f('lot', 'lotStatus', 'Estado del lote', 'Lot status', 'select', nm('lst'), { idSql: 'lst.id', join: 'lst', options: 'catalog:lot_status' }),
      f('lot', 'lotDate', 'Fecha de compra', 'Purchase date', 'date', 'lo.purchase_date', { join: 'lo' }),
      f('lot', 'supplier', 'Proveedor', 'Supplier', 'text', 'sp.name', { join: 'sp', perm: 'suppliers.view' }),
      f('unit', 'lineNo', 'N.º de línea', 'Line no.', 'number', 'll.line_no'),
      f('unit', 'type', 'Tipo de equipo', 'Equipment type', 'select', nm('et'), { idSql: 'et.id', join: 'et', options: 'types' }),
      f('stats', 'expected', 'Cantidad esperada', 'Expected quantity', 'number', 'll.expected_qty'),
      f('stats', 'counted', 'Cantidad contada', 'Counted quantity', 'number', 'll.counted_qty'),
      f('stats', 'difference', 'Diferencia (contado − esperado)', 'Difference (counted − expected)', 'number', '(ll.counted_qty - ll.expected_qty)'),
      f('stats', 'registered', 'Equipos registrados', 'Registered units', 'number', 'ru.n', { join: 'ru' }),
      f('price', 'unitCost', 'Costo por equipo', 'Cost per unit', 'money', 'll.unit_cost', { perm: 'costs.view' }),
      f('unit', 'unexpected', 'No esperada (apareció en el conteo)', 'Unexpected (found when counting)', 'boolean', 'll.is_unexpected'),
      f('unit', 'notes', 'Notas', 'Notes', 'text', 'll.notes'),
    ],
  },

  // ------------------------------------------------------------------ Pedidos
  {
    key: 'orders', es: 'Pedidos de venta', en: 'Sales orders', perm: 'sales.view',
    from: 'sales_orders so', defaultOrder: 'so.id DESC',
    ownWhere: '(so.created_by = {U} OR so.seller_id IN (SELECT id FROM sellers WHERE membership_id = {M}))',
    joins: [
      { alias: 'st', sql: 'JOIN catalog_items st ON st.id = so.status_id' },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = so.customer_id' },
      { alias: 'ct', sql: 'LEFT JOIN catalog_items ct ON ct.id = cu.customer_type_id', deps: ['cu'] },
      { alias: 'se', sql: 'LEFT JOIN sellers se ON se.id = so.seller_id' },
      { alias: 'cb', sql: 'LEFT JOIN users cb ON cb.id = so.created_by' },
      { alias: 'it', sql: `LEFT JOIN LATERAL (SELECT count(*) AS n, sum(x.unit_price) AS total, sum(un.cost) AS cost, count(*) FILTER (WHERE un.cost IS NULL) AS nocost
                              FROM sale_items x JOIN units un ON un.id = x.unit_id WHERE x.order_id = so.id AND x.released_at IS NULL) it ON true` },
      { alias: 'ol', sql: 'LEFT JOIN LATERAL (SELECT sum(quantity) AS n FROM order_lines WHERE order_id = so.id) ol ON true' },
    ],
    fields: [
      f('sale', 'code', 'Código', 'Code', 'text', 'so.code'),
      f('sale', 'status', 'Estado', 'Status', 'select', nm('st'), { idSql: 'st.id', join: 'st', options: 'catalog:order_status' }),
      f('sale', 'customer', 'Cliente', 'Customer', 'text', 'cu.name', { join: 'cu' }),
      f('sale', 'customerType', 'Tipo de cliente', 'Customer type', 'select', nm('ct'), { idSql: 'ct.id', join: 'ct', options: 'catalog:customer_type' }),
      f('sale', 'country', 'País del cliente', 'Customer country', 'text', 'cu.country', { join: 'cu' }),
      f('sale', 'seller', 'Vendedor', 'Seller', 'text', 'se.name', { join: 'se' }),
      f('sale', 'currency', 'Moneda', 'Currency', 'text', 'so.currency::text'),
      f('sale', 'createdBy', 'Creado por', 'Created by', 'text', 'cb.full_name', { join: 'cb' }),
      f('sale', 'createdAt', 'Fecha de creación', 'Created on', 'datetime', 'so.created_at'),
      f('sale', 'reservedUntil', 'Reservado hasta', 'Reserved until', 'datetime', 'so.reserved_until'),
      f('sale', 'completedAt', 'Fecha de venta', 'Completed on', 'datetime', 'so.completed_at'),
      f('sale', 'cancelledAt', 'Fecha de cancelación', 'Cancelled on', 'datetime', 'so.cancelled_at'),
      f('sale', 'notes', 'Notas', 'Notes', 'text', 'so.notes'),
      f('stats', 'units', 'Equipos en el pedido', 'Units in order', 'number', 'it.n', { join: 'it' }),
      f('stats', 'requested', 'Cantidad solicitada', 'Quantity requested', 'number', 'ol.n', { join: 'ol' }),
      f('stats', 'total', 'Subtotal (equipos)', 'Subtotal (items)', 'money', 'it.total', { join: 'it', perm: 'sales.price' }),
      f('price', 'cost', 'Costo de los equipos', 'Cost of items', 'money', 'it.cost', { join: 'it', perm: 'costs.view' }),
      f('price', 'profit', 'Ganancia (subtotal − costo)', 'Profit (subtotal − cost)', 'money', '(it.total - it.cost)', { join: 'it', perm: 'costs.view' }),
      f('price', 'profitPct', 'Margen % sobre el subtotal', 'Margin % of subtotal', 'number', '(CASE WHEN it.total > 0 THEN round((it.total - it.cost) / it.total * 100, 2) END)', { join: 'it', perm: 'costs.view' }),
    ],
  },

  // ------------------------------------------------------------------ Equipos vendidos / de pedidos
  {
    key: 'order_items', es: 'Equipos de pedidos (detalle)', en: 'Order items (detail)', perm: 'sales.view',
    from: 'sale_items si', where: 'si.released_at IS NULL', defaultOrder: 'si.id DESC',
    ownWhere: 'EXISTS (SELECT 1 FROM sales_orders ow WHERE ow.id = si.order_id AND (ow.created_by = {U} OR ow.seller_id IN (SELECT id FROM sellers WHERE membership_id = {M})))',
    specs: { sql: 'u.specs', join: 'u' },
    joins: [
      { alias: 'so', sql: 'JOIN sales_orders so ON so.id = si.order_id' },
      { alias: 'sos', sql: 'JOIN catalog_items sos ON sos.id = so.status_id', deps: ['so'] },
      { alias: 'cu', sql: 'LEFT JOIN customers cu ON cu.id = so.customer_id', deps: ['so'] },
      { alias: 'se', sql: 'LEFT JOIN sellers se ON se.id = so.seller_id', deps: ['so'] },
      { alias: 'u', sql: 'JOIN units u ON u.id = si.unit_id' },
      { alias: 'et', sql: 'JOIN equipment_types et ON et.id = u.equipment_type_id', deps: ['u'] },
      { alias: 'cg', sql: 'LEFT JOIN catalog_items cg ON cg.id = u.cosmetic_grade_id', deps: ['u'] },
      { alias: 'fg', sql: 'LEFT JOIN catalog_items fg ON fg.id = u.functional_grade_id', deps: ['u'] },
      { alias: 'sl', sql: 'LEFT JOIN slots sl ON sl.id = u.slot_id', deps: ['u'] },
      { alias: 'rk', sql: 'LEFT JOIN racks rk ON rk.id = sl.rack_id', deps: ['sl'] },
      { alias: 'ar', sql: 'LEFT JOIN areas ar ON ar.id = rk.area_id', deps: ['rk'] },
      { alias: 'wh', sql: 'LEFT JOIN warehouses wh ON wh.id = ar.warehouse_id', deps: ['ar'] },
    ],
    fields: [
      f('sale', 'order', 'Pedido', 'Order', 'text', 'so.code', { join: 'so' }),
      f('sale', 'orderStatus', 'Estado del pedido', 'Order status', 'select', nm('sos'), { idSql: 'sos.id', join: 'sos', options: 'catalog:order_status' }),
      f('sale', 'customer', 'Cliente', 'Customer', 'text', 'cu.name', { join: 'cu' }),
      f('sale', 'seller', 'Vendedor', 'Seller', 'text', 'se.name', { join: 'se' }),
      f('sale', 'orderDate', 'Fecha del pedido', 'Order date', 'datetime', 'so.created_at', { join: 'so' }),
      f('sale', 'completedAt', 'Fecha de venta', 'Sold on', 'datetime', 'so.completed_at', { join: 'so' }),
      f('sale', 'currency', 'Moneda', 'Currency', 'text', 'so.currency::text', { join: 'so' }),
      f('sale', 'addedAt', 'Agregado al pedido', 'Added to order', 'datetime', 'si.added_at'),
      f('sale', 'price', 'Precio', 'Price', 'money', 'si.unit_price', { perm: 'sales.price' }),
      f('price', 'listPrice', 'Precio de lista', 'List price', 'money', 'u.list_price', { join: 'u', perm: 'sales.price' }),
      f('price', 'cost', 'Costo', 'Cost', 'money', 'u.cost', { join: 'u', perm: 'costs.view' }),
      f('price', 'margin', 'Margen (precio − costo)', 'Margin (price − cost)', 'money', '(si.unit_price - u.cost)', { join: 'u', perm: 'costs.view' }),
      f('price', 'marginPct', 'Margen % sobre el precio', 'Margin % of price', 'number', '(CASE WHEN si.unit_price > 0 THEN round((si.unit_price - u.cost) / si.unit_price * 100, 2) END)', { join: 'u', perm: 'costs.view' }),
      f('unit', 'unit', 'Código del equipo', 'Unit code', 'text', 'u.code', { join: 'u' }),
      f('unit', 'serial', 'Número de serie', 'Serial number', 'text', 'u.serial_number', { join: 'u' }),
      f('unit', 'type', 'Tipo de equipo', 'Equipment type', 'select', nm('et'), { idSql: 'et.id', join: 'et', options: 'types' }),
      f('grades', 'cosmetic', 'Grado cosmético', 'Cosmetic grade', 'select', nm('cg'), { idSql: 'cg.id', join: 'cg', options: 'catalog:cosmetic_grade' }),
      f('grades', 'functional', 'Grado funcional', 'Functional grade', 'select', nm('fg'), { idSql: 'fg.id', join: 'fg', options: 'catalog:functional_grade' }),
      f('location', 'warehouse', 'Almacén', 'Warehouse', 'select', 'wh.name', { idSql: 'wh.id', join: 'wh', options: 'warehouses' }),
      f('location', 'slot', 'Espacio', 'Slot', 'text', 'sl.code', { join: 'sl' }),
    ],
  },

  // ------------------------------------------------------------------ Ubicaciones
  {
    key: 'locations', es: 'Espacios de almacén', en: 'Warehouse slots', perm: 'locations.view',
    from: 'slots sl', defaultOrder: 'sl.code',
    joins: [
      { alias: 'rk', sql: 'JOIN racks rk ON rk.id = sl.rack_id' },
      { alias: 'ar', sql: 'JOIN areas ar ON ar.id = rk.area_id', deps: ['rk'] },
      { alias: 'wh', sql: 'JOIN warehouses wh ON wh.id = ar.warehouse_id', deps: ['ar'] },
      { alias: 'us', sql: 'LEFT JOIN LATERAL (SELECT count(*) AS n FROM units WHERE slot_id = sl.id) us ON true' },
    ],
    fields: [
      f('location', 'warehouse', 'Almacén', 'Warehouse', 'select', 'wh.name', { idSql: 'wh.id', join: 'wh', options: 'warehouses' }),
      f('location', 'area', 'Área', 'Area', 'text', 'ar.name', { join: 'ar' }),
      f('location', 'rack', 'Rack', 'Rack', 'text', 'rk.code', { join: 'rk' }),
      f('location', 'level', 'Nivel', 'Level', 'number', 'sl.level_no'),
      f('location', 'slotNo', 'N.º de espacio', 'Slot no.', 'number', 'sl.slot_no'),
      f('location', 'slot', 'Código del espacio', 'Slot code', 'text', 'sl.code'),
      f('location', 'active', 'Activo', 'Active', 'boolean', 'sl.is_active'),
      f('stats', 'capacity', 'Capacidad', 'Capacity', 'number', 'sl.capacity'),
      f('stats', 'used', 'Ocupado', 'Used', 'number', 'us.n', { join: 'us' }),
      f('stats', 'free', 'Libre', 'Free', 'number', '(sl.capacity - us.n)', { join: 'us' }),
      f('stats', 'full', 'Lleno', 'Full', 'boolean', '(us.n >= sl.capacity)', { join: 'us' }),
    ],
  },
];

export const datasetByKey = (key: string) => DATASETS.find((d) => d.key === key);

// ---------------------------------------------------------------------------- operadores

export const OPS_BY_TYPE: Record<FType, string[]> = {
  text: ['contains', 'notContains', 'startsWith', 'endsWith', 'eq', 'ne', 'empty', 'notEmpty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty'],
  money: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty'],
  date: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'lastDays', 'thisMonth', 'thisYear', 'empty', 'notEmpty'],
  datetime: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'lastDays', 'thisMonth', 'thisYear', 'empty', 'notEmpty'],
  boolean: ['is'],
  select: ['in', 'notIn', 'empty', 'notEmpty'],
};
export const ALL_OPS = [...new Set(Object.values(OPS_BY_TYPE).flat())] as [string, ...string[]];

// ---------------------------------------------------------------------------- campos dinámicos (atributos)

interface AttrRow { key: string; label: Record<string, string>; data_type: string; catalog_id: number | null; unit: string | null; own_catalogs: number[] | null }

function attrField(a: AttrRow, specs: string, join: string | undefined): FieldDef {
  const k = a.key; // ya validado por la base: ^[a-z][a-z0-9_]*$
  if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('clave de atributo inválida');
  const jb = `${specs}->'${k}'`;
  const tx = `(${specs}->>'${k}')`;
  const suffix = a.unit && a.data_type === 'number' ? ` (${a.unit})` : '';
  const base = { key: `attr:${k}`, es: tr(a.label, 'es') + suffix, en: tr(a.label, 'en') + suffix, group: 'attrs', join } as const;
  switch (a.data_type) {
    case 'number':
      return { ...base, type: 'number', sql: `(CASE WHEN jsonb_typeof(${jb}) = 'number' THEN ${tx}::numeric END)` };
    case 'boolean':
      return { ...base, type: 'boolean', sql: `(CASE WHEN jsonb_typeof(${jb}) = 'boolean' THEN ${tx}::boolean END)` };
    case 'date':
      return { ...base, type: 'date', sql: `(CASE WHEN ${tx} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN ${tx}::date END)` };
    case 'select':
      return {
        ...base, type: 'select', options: `catalogIds:${[a.catalog_id, ...(a.own_catalogs ?? [])].filter((x) => x != null).join(',')}`, idSql: `(CASE WHEN jsonb_typeof(${jb}) = 'number' THEN ${tx} END)`,
        sql: `(SELECT ${nm('ci')} FROM catalog_items ci WHERE ci.id = (CASE WHEN jsonb_typeof(${jb}) = 'number' THEN ${tx}::bigint END))`,
      };
    case 'multiselect':
      return {
        ...base, type: 'text',
        sql: `(SELECT string_agg(${nm('ci')}, ', ' ORDER BY ci.sort_order) FROM catalog_items ci
                WHERE ci.id IN (SELECT (jsonb_array_elements_text(CASE WHEN jsonb_typeof(${jb}) = 'array' THEN ${jb} ELSE '[]'::jsonb END))::bigint))`,
      };
    default:
      return { ...base, type: 'text', sql: tx };
  }
}

export interface ResolvedDataset { ds: Dataset; fields: Map<string, FieldDef>; order: string[] }

/** Campos fijos del conjunto + un campo por cada atributo definido en el sistema (marca, RAM, etc.). */
export async function resolveDataset(db: Db, key: string): Promise<ResolvedDataset> {
  const ds = datasetByKey(key);
  if (!ds) throw badRequest('report_dataset_unknown', { dataset: key });
  const fields = new Map<string, FieldDef>();
  const order: string[] = [];
  for (const fd of ds.fields) { fields.set(fd.key, fd); order.push(fd.key); }
  if (ds.specs) {
    const attrs = await db.rows<AttrRow>(
      `SELECT a.key, a.label, a.data_type, a.catalog_id, a.unit,
              (SELECT array_agg(DISTINCT e.catalog_id) FROM equipment_type_attributes e WHERE e.attribute_id = a.id AND e.catalog_id IS NOT NULL) AS own_catalogs
         FROM attribute_definitions a ORDER BY a.is_active DESC, a.key`);
    for (const a of attrs) {
      const fd = attrField(a, ds.specs.sql, ds.specs.join);
      fields.set(fd.key, fd); order.push(fd.key);
    }
  }
  return { ds, fields, order };
}

// ---------------------------------------------------------------------------- definición y consulta

export interface ColDef { field: string; label?: string; agg?: Agg }
export interface FilterDef { field: string; op: string; a?: string; b?: string; list?: string[] }
export interface ReportDef {
  mode: 'detail' | 'summary';
  columns: ColDef[];
  filters: FilterDef[];
  sort: { col: number; dir: 'asc' | 'desc' }[];
  limit?: number;
}
export interface OutCol { key: string; label: string; type: FType; agg?: Agg }
export interface BuiltQuery { sql: string; params: unknown[]; columns: OutCol[]; limit: number }

const AGG_ES: Record<Agg, string> = { count: 'Cantidad', countDistinct: 'Cantidad distinta de', sum: 'Suma de', avg: 'Promedio de', min: 'Mínimo de', max: 'Máximo de' };
const AGG_EN: Record<Agg, string> = { count: 'Count', countDistinct: 'Distinct count of', sum: 'Sum of', avg: 'Average of', min: 'Minimum of', max: 'Maximum of' };

const badDef = (field: string, extra: Record<string, unknown> = {}) => badRequest('report_invalid_definition', { field, ...extra });
const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: string | undefined, field: string): number {
  const n = Number(String(v ?? '').trim().replace(',', '.'));
  if (v === undefined || String(v).trim() === '' || !Number.isFinite(n)) throw badDef(field);
  return n;
}
function day(v: string | undefined, field: string): string {
  if (!v || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw badDef(field);
  return v;
}

function filterSql(fd: FieldDef, fl: FilterDef, e: string, id: string, p: (v: unknown) => string): string {
  if (!OPS_BY_TYPE[fd.type].includes(fl.op)) throw badDef(fd.key, { op: fl.op });
  if (fl.op === 'empty' || fl.op === 'notEmpty') {
    const isNull = fd.type === 'select' ? `${id} IS NULL` : fd.type === 'text' ? `(${e} IS NULL OR ${e} = '')` : `${e} IS NULL`;
    return fl.op === 'empty' ? isNull : `NOT (${isNull})`;
  }
  switch (fd.type) {
    case 'text': {
      const a = (fl.a ?? '').trim();
      if (!a) throw badDef(fd.key);
      switch (fl.op) {
        case 'contains': return `${e} ILIKE ${p(`%${escLike(a)}%`)}`;
        case 'notContains': return `(${e} IS NULL OR ${e} NOT ILIKE ${p(`%${escLike(a)}%`)})`;
        case 'startsWith': return `${e} ILIKE ${p(`${escLike(a)}%`)}`;
        case 'endsWith': return `${e} ILIKE ${p(`%${escLike(a)}`)}`;
        case 'eq': return `lower(${e}) = lower(${p(a)})`;
        case 'ne': return `(${e} IS NULL OR lower(${e}) <> lower(${p(a)}))`;
      }
      break;
    }
    case 'number': case 'money': {
      const cmp: Record<string, string> = { eq: '=', gt: '>', ge: '>=', lt: '<', le: '<=' };
      if (fl.op === 'between') {
        const parts: string[] = [];
        if (fl.a?.trim()) parts.push(`${e} >= ${p(num(fl.a, fd.key))}::numeric`);
        if (fl.b?.trim()) parts.push(`${e} <= ${p(num(fl.b, fd.key))}::numeric`);
        if (!parts.length) throw badDef(fd.key);
        return `(${parts.join(' AND ')})`;
      }
      if (fl.op === 'ne') return `(${e} IS NULL OR ${e} <> ${p(num(fl.a, fd.key))}::numeric)`;
      return `${e} ${cmp[fl.op]} ${p(num(fl.a, fd.key))}::numeric`;
    }
    case 'date': case 'datetime': {
      const d = `(${e})::date`;
      const cmp: Record<string, string> = { eq: '=', gt: '>', ge: '>=', lt: '<', le: '<=' };
      switch (fl.op) {
        case 'between': {
          const parts: string[] = [];
          if (fl.a) parts.push(`${d} >= ${p(day(fl.a, fd.key))}::date`);
          if (fl.b) parts.push(`${d} <= ${p(day(fl.b, fd.key))}::date`);
          if (!parts.length) throw badDef(fd.key);
          return `(${parts.join(' AND ')})`;
        }
        case 'ne': return `(${e} IS NULL OR ${d} <> ${p(day(fl.a, fd.key))}::date)`;
        case 'lastDays': {
          const n = Math.round(num(fl.a, fd.key));
          if (n < 1 || n > 3650) throw badDef(fd.key);
          return `${d} BETWEEN current_date - ${p(n)}::int AND current_date`;
        }
        case 'thisMonth': return `(${d} >= date_trunc('month', current_date)::date AND ${d} < (date_trunc('month', current_date) + interval '1 month')::date)`;
        case 'thisYear': return `(${d} >= date_trunc('year', current_date)::date AND ${d} < (date_trunc('year', current_date) + interval '1 year')::date)`;
        default: return `${d} ${cmp[fl.op]} ${p(day(fl.a, fd.key))}::date`;
      }
    }
    case 'boolean':
      if (fl.a !== 'true' && fl.a !== 'false') throw badDef(fd.key);
      return fl.a === 'true' ? `${e} IS TRUE` : `${e} IS NOT TRUE`;
    case 'select': {
      const list = (fl.list ?? []).map(String);
      if (!list.length) throw badDef(fd.key);
      const has = `${id}::text = ANY(${p(list)}::text[])`;
      return fl.op === 'notIn' ? `(${id} IS NULL OR NOT (${has}))` : has;
    }
  }
  throw badDef(fd.key);
}

export interface BuildOpts { lang: Lang; can: (perm: string) => boolean; limit: number; strict: boolean; who?: { userId: number; membershipId: number } }

/**
 * Convierte la definición de un reporte en una consulta SQL segura.
 *  - strict (al guardar): cualquier campo desconocido o sin permiso es un error.
 *  - no strict (al ejecutar): en reportes de detalle, las columnas que ya no existen o que el usuario no puede ver
 *    se omiten; en filtros/agrupaciones/cálculos sin permiso siempre es un error (nunca se filtra información).
 */
export function buildQuery(rd: ResolvedDataset, def: ReportDef, o: BuildOpts): BuiltQuery {
  const { ds, fields } = rd;
  const L = o.lang === 'en' ? "'en'" : "'es'";
  const sub = (s: string) => s.replaceAll('{L}', L);
  const AGGS = o.lang === 'en' ? AGG_EN : AGG_ES;
  const summary = def.mode === 'summary';
  const needs = new Set<string>();
  const need = (j?: string) => { if (j) needs.add(j); };

  interface P { orig: number; expr: string; isAgg: boolean; out: OutCol }
  const cols: P[] = [];
  for (const [i, c] of def.columns.entries()) {
    const agg = summary ? c.agg : undefined;
    if (c.field === '*') {
      if (agg !== 'count') throw badDef('*');
      cols.push({ orig: i, expr: 'count(*)', isAgg: true, out: { key: '*', label: c.label?.trim() || AGGS.count, type: 'number', agg } });
      continue;
    }
    const fd = fields.get(c.field);
    if (!fd) {
      if (!summary && !o.strict) continue;
      throw badRequest('report_field_unknown', { field: c.field });
    }
    if (!permOk(o.can, fd.perm)) {
      if (!summary && !o.strict) continue;
      throw forbidden('report_field_forbidden', { field: c.field });
    }
    const e = sub(fd.sql);
    need(fd.join);
    const fieldLabel = o.lang === 'en' ? fd.en : fd.es;
    if (!agg) {
      cols.push({ orig: i, expr: e, isAgg: false, out: { key: c.field, label: c.label?.trim() || fieldLabel, type: fd.type } });
      continue;
    }
    const numeric = fd.type === 'number' || fd.type === 'money';
    if ((agg === 'sum' || agg === 'avg') && !numeric) throw badDef(c.field, { agg });
    if ((agg === 'min' || agg === 'max') && fd.type === 'boolean') throw badDef(c.field, { agg });
    const label = c.label?.trim() || `${AGGS[agg]} ${fieldLabel}`;
    switch (agg) {
      case 'count': cols.push({ orig: i, expr: `count(${e})`, isAgg: true, out: { key: c.field, label, type: 'number', agg } }); break;
      case 'countDistinct': cols.push({ orig: i, expr: `count(DISTINCT ${e})`, isAgg: true, out: { key: c.field, label, type: 'number', agg } }); break;
      case 'sum': cols.push({ orig: i, expr: `sum(${e})`, isAgg: true, out: { key: c.field, label, type: fd.type, agg } }); break;
      case 'avg': cols.push({ orig: i, expr: `round(avg(${e})::numeric, 2)`, isAgg: true, out: { key: c.field, label, type: fd.type, agg } }); break;
      case 'min': case 'max': cols.push({ orig: i, expr: `${agg}(${e})`, isAgg: true, out: { key: c.field, label, type: fd.type === 'select' ? 'text' : fd.type, agg } }); break;
    }
  }
  if (!cols.length) throw badRequest('report_no_columns');
  if (summary && !cols.some((c) => c.isAgg)) throw badRequest('report_needs_aggregate');

  // filtros
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const where: string[] = ds.where ? [ds.where] : [];
  // Quien no ve las ventas de todos, en los conjuntos de ventas solo ve las suyas.
  if (ds.ownWhere && !o.can('sales.view_all')) {
    if (!o.who) throw forbidden('report_dataset_forbidden', { dataset: ds.key });
    where.push(ds.ownWhere.replaceAll('{U}', String(Math.trunc(o.who.userId))).replaceAll('{M}', String(Math.trunc(o.who.membershipId))));
  }
  for (const fl of def.filters) {
    const fd = fields.get(fl.field);
    if (!fd) throw badRequest('report_field_unknown', { field: fl.field });
    if (!permOk(o.can, fd.perm)) throw forbidden('report_field_forbidden', { field: fl.field });
    need(fd.join);
    const e = sub(fd.sql);
    where.push(filterSql(fd, fl, e, fd.idSql ? sub(fd.idSql) : e, p));
  }

  // orden
  const order: string[] = [];
  const dims = cols.map((c, i) => ({ c, i })).filter((x) => !x.c.isAgg);
  for (const s of def.sort) {
    const pos = cols.findIndex((c) => c.orig === s.col);
    if (pos < 0) { if (o.strict) throw badDef('sort'); continue; }
    order.push(`${pos + 1} ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
  }
  if (!order.length) {
    if (summary) { if (dims.length) order.push(...dims.map((d) => `${d.i + 1} ASC NULLS LAST`)); }
    else order.push(ds.defaultOrder);
  }

  // joins necesarios (con dependencias), en el orden declarado
  const byAlias = new Map(ds.joins.map((j) => [j.alias, j]));
  const closure = new Set<string>();
  const visit = (a: string) => {
    if (closure.has(a)) return;
    const j = byAlias.get(a);
    if (!j) return;
    for (const d of j.deps ?? []) visit(d);
    closure.add(a);
  };
  for (const a of needs) visit(a);
  const joins = ds.joins.filter((j) => closure.has(j.alias)).map((j) => sub(j.sql));

  const limit = Math.max(1, Math.min(def.limit ?? o.limit, o.limit));
  const groupBy = summary && dims.length ? `GROUP BY ${dims.map((d) => d.i + 1).join(', ')}` : '';
  const sql = [
    `SELECT ${cols.map((c, i) => `${c.expr} AS c${i}`).join(', ')}`,
    `FROM ${ds.from}`,
    ...joins,
    where.length ? `WHERE ${where.join(' AND ')}` : '',
    groupBy,
    order.length ? `ORDER BY ${order.join(', ')}` : '',
    `LIMIT ${limit + 1}`,
  ].filter(Boolean).join('\n');

  return { sql, params, columns: cols.map((c) => c.out), limit };
}

// ---------------------------------------------------------------------------- metadatos para el diseñador

export interface MetaField { key: string; label: string; type: FType; group: string; options?: { value: string; label: string }[] }
export interface MetaDataset { key: string; label: string; fields: MetaField[] }

/** Conjuntos y campos que este usuario puede usar (los que exigen un permiso que no tiene ni aparecen). */
export async function loadMeta(db: Db, lang: Lang, can: (p: string) => boolean): Promise<MetaDataset[]> {
  const cats = await db.rows<{ id: number; key: string; name: Record<string, string>; sort_order: number; item_id: number; item_name: Record<string, string> }>(
    `SELECT c.id, c.key, c.name, ci.sort_order, ci.id AS item_id, ci.name AS item_name
       FROM catalogs c JOIN catalog_items ci ON ci.catalog_id = c.id ORDER BY ci.sort_order, ci.id`);
  const byKey = new Map<string, { value: string; label: string }[]>();
  const byId = new Map<number, { value: string; label: string }[]>();
  for (const r of cats) {
    const o = { value: String(r.item_id), label: tr(r.item_name, lang) };
    (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(o);
    (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)!).push(o);
  }
  const types = (await db.rows<{ id: number; name: Record<string, string> }>('SELECT id, name FROM equipment_types ORDER BY sort_order, id'))
    .map((t) => ({ value: String(t.id), label: tr(t.name, lang) }));
  const whs = (await db.rows<{ id: number; name: string }>('SELECT id, name FROM warehouses ORDER BY code')).map((w) => ({ value: String(w.id), label: w.name }));

  const optionsFor = (spec: string | undefined) => {
    if (!spec) return undefined;
    if (spec === 'types') return types;
    if (spec === 'warehouses') return whs;
    if (spec.startsWith('catalog:')) return byKey.get(spec.slice(8)) ?? [];
    if (spec.startsWith('catalogId:')) return byId.get(Number(spec.slice(10))) ?? [];
    // Propiedad de lista con catálogo propio por tipo de equipo (p. ej. modelo): las opciones de todos ellos.
    if (spec.startsWith('catalogIds:')) return [...new Set(spec.slice(11).split(',').map(Number))].flatMap((id) => byId.get(id) ?? []);
    return undefined;
  };

  const out: MetaDataset[] = [];
  for (const d of DATASETS) {
    if (!can(d.perm)) continue;
    const rd = await resolveDataset(db, d.key);
    const fields: MetaField[] = [];
    for (const k of rd.order) {
      const fd = rd.fields.get(k)!;
      if (!permOk(can, fd.perm)) continue;
      fields.push({ key: fd.key, label: lang === 'en' ? fd.en : fd.es, type: fd.type, group: fd.group, ...(fd.type === 'select' ? { options: optionsFor(fd.options) ?? [] } : {}) });
    }
    out.push({ key: d.key, label: lang === 'en' ? d.en : d.es, fields });
  }
  return out;
}

/** ¿Este usuario puede ejecutar el reporte? (permiso del conjunto y de todo lo que filtra, agrupa o calcula) */
export function canRun(rd: ResolvedDataset, def: ReportDef, can: (p: string) => boolean): boolean {
  if (!can(rd.ds.perm)) return false;
  const ok = (key: string) => { const fd = rd.fields.get(key); return !fd || permOk(can, fd.perm); };
  for (const fl of def.filters) if (!ok(fl.field)) return false;
  let visible = 0;
  for (const c of def.columns) {
    if (c.field === '*') { visible++; continue; }
    if (ok(c.field)) visible++;
    else if (def.mode === 'summary') return false;
  }
  return visible > 0;
}
