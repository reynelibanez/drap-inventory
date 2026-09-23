import type { Db } from './db.js';

/**
 * Catálogo de funciones del sistema a las que se puede dar (o quitar) acceso.
 * Se sincroniza con la tabla `permissions` al arrancar. Si agregas una función
 * nueva al sistema, agrégala aquí: aparece sola en la pantalla de roles.
 */
export interface PermissionDef {
  key: string;
  module: string;
  es: string;
  en: string;
}

const P = (key: string, es: string, en: string): PermissionDef => ({ key, module: key.split('.')[0], es, en });

export const PERMISSIONS: PermissionDef[] = [
  P('dashboard.view', 'Ver el panel principal', 'View dashboard'),

  P('catalogs.view', 'Ver catálogos', 'View catalogs'),
  P('catalogs.manage', 'Crear y editar catálogos y sus valores', 'Create and edit catalogs and their values'),
  P('equipment.view', 'Ver tipos de equipo y atributos', 'View equipment types and attributes'),
  P('equipment.manage', 'Crear y editar tipos de equipo y atributos', 'Create and edit equipment types and attributes'),

  P('labels.manage', 'Diseñar etiquetas y documentos (de equipo/testeo, de lote y de pedido) y asociarlas a tipos de equipo', 'Design labels and documents (unit/testing, lot and order) and link them to equipment types'),

  P('suppliers.view', 'Ver proveedores', 'View suppliers'),
  P('suppliers.manage', 'Crear y editar proveedores', 'Create and edit suppliers'),

  P('lots.view', 'Ver lotes', 'View lots'),
  P('lots.create', 'Crear lotes y sus líneas', 'Create lots and their lines'),
  P('lots.edit', 'Editar lotes y sus líneas', 'Edit lots and their lines'),
  P('lots.count', 'Registrar el conteo físico', 'Record physical counts'),
  P('lots.close', 'Cambiar el estado del lote (cerrar, reabrir...)', 'Change lot status (close, reopen...)'),
  P('lots.delete', 'Eliminar lotes vacíos', 'Delete empty lots'),
  P('lots.import', 'Importar equipos desde un archivo CSV', 'Import equipment from a CSV file'),

  P('units.view', 'Ver equipos', 'View units'),
  P('units.test', 'Testear equipos (registrar y terminar testeo)', 'Test units (register and finish testing)'),
  P('units.edit', 'Editar datos de equipos', 'Edit unit data'),
  P('units.change_status', 'Cambiar manualmente el estado de un equipo', 'Manually change a unit status'),

  P('assets.view', 'Ver los activos de la empresa (herramientas y equipos propios)', 'View company assets (own tools and equipment)'),
  P('assets.manage', 'Registrar, editar y dar de baja activos de la empresa', 'Register, edit and retire company assets'),

  P('locations.view', 'Ver almacenes y ubicaciones', 'View warehouses and locations'),
  P('locations.manage', 'Crear y editar almacenes, áreas, racks y espacios', 'Create and edit warehouses, areas, racks and slots'),
  P('locations.assign', 'Ubicar y mover equipos', 'Place and move units'),

  P('customers.view', 'Ver clientes', 'View customers'),
  P('customers.manage', 'Crear y editar clientes', 'Create and edit customers'),
  P('sellers.view', 'Ver vendedores', 'View sellers'),
  P('sellers.manage', 'Crear y editar vendedores', 'Create and edit sellers'),

  P('sales.view', 'Ver ventas', 'View sales'),
  P('sales.view_all', 'Ver las ventas de TODOS los vendedores (si se quita, solo ve las suyas: las que creó o donde es el vendedor)', "View EVERYONE'S sales (if removed, sees only their own: the ones they created or where they are the seller)"),
  P('sales.create', 'Crear pedidos y reservar equipos', 'Create orders and reserve units'),
  P('sales.edit', 'Editar pedidos abiertos y sus datos de envío', 'Edit open orders and their shipping details'),
  P('sales.price', 'Ver y fijar precios', 'View and set prices'),
  P('sales.complete', 'Completar ventas', 'Complete sales'),
  P('sales.cancel', 'Cancelar pedidos', 'Cancel orders'),

  P('costs.view', 'Ver los costos de lotes y equipos y los márgenes de ganancia', 'View lot and unit costs and profit margins'),
  P('costs.manage', 'Repartir y editar los costos de lotes y equipos', 'Distribute and edit lot and unit costs'),
  P('prices.manage', 'Administrar precios de lista y reglas de precio', 'Manage list prices and price rules'),

  P('users.view', 'Ver usuarios de la empresa', 'View company users'),
  P('users.manage', 'Crear y editar usuarios y sus permisos', 'Create and edit users and their permissions'),
  P('roles.view', 'Ver roles', 'View roles'),
  P('roles.manage', 'Crear y editar roles', 'Create and edit roles'),

  P('reports.view', 'Ver y ejecutar reportes', 'View and run reports'),
  P('reports.create', 'Crear sus propios reportes (privados)', 'Create own (private) reports'),
  P('reports.share', 'Compartir reportes con toda la empresa y editar los compartidos', 'Share reports with the whole company and edit shared ones'),

  P('audit.view', 'Ver el historial de cambios', 'View audit history'),
  P('settings.manage', 'Cambiar ajustes de la empresa', 'Change company settings'),

  P('billing.manage', 'Ver y administrar la suscripción y facturación de la empresa', 'View and manage the company subscription and billing'),
];

export const ALL_PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

const view = PERMISSIONS.filter((p) => p.key.endsWith('.view')).map((p) => p.key);

/** Roles que se crean con cada empresa nueva (después son totalmente editables). */
export const DEFAULT_ROLES: { name: { es: string; en: string }; description: { es: string; en: string }; permissions: string[] }[] = [
  {
    name: { es: 'Administrador', en: 'Administrator' },
    description: { es: 'Acceso completo', en: 'Full access' },
    permissions: ALL_PERMISSION_KEYS,
  },
  {
    name: { es: 'Técnico', en: 'Technician' },
    description: { es: 'Cuenta y testea equipos', en: 'Counts and tests units' },
    permissions: [
      'dashboard.view', 'catalogs.view', 'equipment.view', 'lots.view', 'lots.count',
      'units.view', 'units.test', 'units.edit', 'locations.view', 'locations.assign', 'assets.view',
      'reports.view', 'reports.create',
    ],
  },
  {
    name: { es: 'Almacén', en: 'Warehouse' },
    description: { es: 'Recibe lotes y ubica equipos', en: 'Receives lots and places units' },
    permissions: [
      'dashboard.view', 'catalogs.view', 'equipment.view', 'suppliers.view', 'suppliers.manage',
      'lots.view', 'lots.create', 'lots.edit', 'lots.count', 'lots.close', 'lots.import',
      'units.view', 'locations.view', 'locations.manage', 'locations.assign', 'assets.view', 'assets.manage',
      'reports.view', 'reports.create',
    ],
  },
  {
    name: { es: 'Ventas', en: 'Sales' },
    description: { es: 'Gestiona clientes y pedidos', en: 'Manages customers and orders' },
    permissions: [
      'dashboard.view', 'catalogs.view', 'equipment.view', 'units.view', 'lots.view',
      'customers.view', 'customers.manage', 'sellers.view',
      'sales.view', 'sales.create', 'sales.edit', 'sales.price', 'sales.complete', 'sales.cancel',
      'reports.view', 'reports.create',
    ],
  },
  {
    name: { es: 'Solo consulta', en: 'Read only' },
    description: { es: 'Puede ver pero no modificar', en: 'Can view but not modify' },
    permissions: [...view.filter((k) => !['users.view', 'roles.view', 'audit.view'].includes(k)), 'sales.view_all'],
  },
];

/** Sincroniza el catálogo de permisos con la base (alta o actualización de textos). */
export async function syncPermissions(db: Db): Promise<void> {
  let order = 0;
  for (const p of PERMISSIONS) {
    await db.query(
      `INSERT INTO permissions (key, module, name, sort_order) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET module = EXCLUDED.module, name = EXCLUDED.name, sort_order = EXCLUDED.sort_order`,
      [p.key, p.module, JSON.stringify({ es: p.es, en: p.en }), order++],
    );
  }
}
