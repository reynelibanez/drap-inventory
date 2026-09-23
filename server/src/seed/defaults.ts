import { seedProcessorGenerations } from '../services/generationDefaults.js';
import type { Db } from '../db.js';
import { DEFAULT_ROLES } from '../permissions.js';
import { ensureDefaultLabelTemplate } from '../services/labelDefaults.js';
import { ASSET_STATUS_CATALOG, markAssetsSeeded } from '../services/assetDefaults.js';
import { seedModelCatalogs } from '../services/modelDefaults.js';
import { seedSystemReports } from '../services/reportDefaults.js';
import { seedImportAttributes, seedDesktopFormFactor } from '../services/importDefaults.js';

/**
 * Datos iniciales de cada empresa nueva. Son solo un punto de partida:
 * todo se puede renombrar, ampliar, desactivar o reordenar desde la aplicación.
 */

interface Item {
  code?: string;
  es: string;
  en?: string;             // si se omite, se usa el mismo texto (nombres propios, medidas)
  systemKey?: string;      // solo para valores de los que depende la lógica del sistema
  color?: string;
  meta?: Record<string, unknown>;
}

interface CatalogDef { key: string; es: string; en: string; system?: boolean; items: Item[] }

const same = (...names: string[]): Item[] => names.map((n) => ({ es: n }));
const sizes = (unit: string, ...values: (string | number)[]): Item[] => values.map((v) => ({ code: String(v), es: `${v} ${unit}` }));

const CATALOGS: CatalogDef[] = [
  {
    key: 'unit_status', es: 'Estados de equipo', en: 'Unit statuses', system: true,
    items: [
      { systemKey: 'testing', es: 'En testeo', en: 'In testing', color: '#f59e0b' },
      { systemKey: 'available', es: 'Disponible', en: 'Available', color: '#16a34a' },
      { systemKey: 'reserved', es: 'Reservado', en: 'Reserved', color: '#2563eb' },
      { systemKey: 'sold', es: 'Vendido', en: 'Sold', color: '#6b7280' },
      { systemKey: 'not_sellable', es: 'No vendible', en: 'Not sellable', color: '#dc2626' },
    ],
  },
  { key: 'asset_status', ...ASSET_STATUS_CATALOG },
  {
    key: 'lot_status', es: 'Estados de lote', en: 'Lot statuses', system: true,
    items: [
      { systemKey: 'open', es: 'Registrado', en: 'Registered', color: '#6b7280' },
      { systemKey: 'counting', es: 'En conteo', en: 'Counting', color: '#f59e0b' },
      { systemKey: 'counted', es: 'Contado', en: 'Counted', color: '#0ea5e9' },
      { systemKey: 'testing', es: 'En testeo', en: 'In testing', color: '#8b5cf6' },
      { systemKey: 'closed', es: 'Cerrado', en: 'Closed', color: '#16a34a' },
    ],
  },
  {
    key: 'order_status', es: 'Estados de pedido', en: 'Order statuses', system: true,
    items: [
      { systemKey: 'open', es: 'Abierto', en: 'Open', color: '#2563eb' },
      { systemKey: 'completed', es: 'Completado', en: 'Completed', color: '#16a34a' },
      { systemKey: 'cancelled', es: 'Cancelado', en: 'Cancelled', color: '#dc2626' },
    ],
  },
  {
    key: 'cosmetic_grade', es: 'Grados cosméticos', en: 'Cosmetic grades',
    items: [
      { code: 'A', es: 'Como nuevo', en: 'Like new', color: '#16a34a' },
      { code: 'B', es: 'Buen estado', en: 'Good', color: '#84cc16' },
      { code: 'C', es: 'Desgaste visible', en: 'Visible wear', color: '#f59e0b' },
      { code: 'D', es: 'Muy usado', en: 'Heavy wear', color: '#ef4444' },
    ],
  },
  {
    key: 'functional_grade', es: 'Grados funcionales', en: 'Functional grades',
    items: [
      { code: 'A', es: 'Funciona al 100%', en: 'Fully functional', color: '#16a34a' },
      { code: 'B', es: 'Detalles menores', en: 'Minor issues', color: '#84cc16' },
      { code: 'C', es: 'Con fallas', en: 'Works with faults', color: '#f59e0b' },
      // meta.sellable=false: al terminar el testeo con este grado, el equipo queda "No vendible".
      { code: 'F', es: 'No funciona', en: 'Not working', color: '#dc2626', meta: { sellable: false } },
    ],
  },
  {
    key: 'brand', es: 'Marcas', en: 'Brands',
    items: same('Dell', 'HP', 'Lenovo', 'Apple', 'Acer', 'Asus', 'Toshiba', 'Samsung', 'LG', 'Microsoft', 'MSI', 'Fujitsu',
      'Panasonic', 'Gateway', 'AOC', 'ViewSonic', 'BenQ', 'Philips', 'Kingston', 'Crucial', 'Corsair', 'Seagate',
      'Western Digital', 'Hitachi', 'SanDisk', 'Micron', 'Intel', 'Sony', 'Huawei', 'Razer'),
  },
  {
    key: 'processor', es: 'Procesadores', en: 'Processors',
    items: same('Intel Core i3', 'Intel Core i5', 'Intel Core i7', 'Intel Core i9', 'Intel Core 2 Duo', 'Intel Pentium', 'Intel Celeron',
      'Intel Xeon', 'AMD Ryzen 3', 'AMD Ryzen 5', 'AMD Ryzen 7', 'AMD Ryzen 9', 'AMD A-Series', 'Apple M1', 'Apple M2', 'Apple M3'),
  },
  {
    key: 'processor_generation', es: 'Generaciones de procesador', en: 'Processor generations',
    // Los valores (número completo de la BIOS: i5-6300U…) los carga `seedProcessorGenerations`, cada uno ligado a su procesador.
    items: [],
  },
  { key: 'ram_size', es: 'Capacidades de RAM', en: 'RAM sizes', items: sizes('GB', 2, 4, 8, 12, 16, 24, 32, 64) },
  { key: 'ram_type', es: 'Tipos de RAM', en: 'RAM types', items: same('DDR2', 'DDR3', 'DDR3L', 'DDR4', 'DDR5', 'LPDDR4', 'LPDDR5') },
  {
    key: 'storage_type', es: 'Tipos de almacenamiento', en: 'Storage types',
    items: [
      { es: 'HDD', en: 'HDD' }, { es: 'SSD SATA', en: 'SATA SSD' }, { es: 'SSD NVMe', en: 'NVMe SSD' },
      { es: 'eMMC', en: 'eMMC' }, { es: 'Sin disco', en: 'No drive' },
    ],
  },
  {
    key: 'storage_size', es: 'Capacidades de disco', en: 'Storage sizes',
    items: [
      ...sizes('GB', 120, 128, 240, 256, 320, 480, 500, 512, 750),
      { code: '1TB', es: '1 TB' }, { code: '2TB', es: '2 TB' }, { code: '4TB', es: '4 TB' },
    ],
  },
  {
    key: 'screen_size', es: 'Tamaños de pantalla', en: 'Screen sizes',
    items: [11.6, 12.5, 13.3, 14, 15.6, 17.3, 19, 20, 21.5, 22, 23.8, 24, 27, 32].map((v) => ({ code: String(v), es: `${v}"` })),
  },
  {
    key: 'customer_type', es: 'Tipos de cliente', en: 'Customer types',
    items: [
      { es: 'Importador', en: 'Importer' }, { es: 'Distribuidor', en: 'Distributor' },
      { es: 'Minorista', en: 'Retailer' }, { es: 'Cliente final', en: 'End customer' },
    ],
  },
];

interface AttrDef { key: string; es: string; en: string; type: 'text' | 'number' | 'boolean' | 'select'; catalog?: string; unit?: string }

const ATTRIBUTES: AttrDef[] = [
  { key: 'brand', es: 'Marca', en: 'Brand', type: 'select', catalog: 'brand' },
  { key: 'model', es: 'Modelo', en: 'Model', type: 'text' },
  { key: 'processor', es: 'Procesador', en: 'Processor', type: 'select', catalog: 'processor' },
  { key: 'generation', es: 'Generación', en: 'Generation', type: 'select', catalog: 'processor_generation' },
  { key: 'ram', es: 'RAM', en: 'RAM', type: 'select', catalog: 'ram_size' },
  { key: 'ram_type', es: 'Tipo de RAM', en: 'RAM type', type: 'select', catalog: 'ram_type' },
  { key: 'storage_type', es: 'Tipo de disco', en: 'Drive type', type: 'select', catalog: 'storage_type' },
  { key: 'storage_size', es: 'Capacidad de disco', en: 'Drive size', type: 'select', catalog: 'storage_size' },
  { key: 'screen_size', es: 'Pantalla', en: 'Screen', type: 'select', catalog: 'screen_size' },
  { key: 'resolution', es: 'Resolución', en: 'Resolution', type: 'text' },
  { key: 'memory_speed', es: 'Velocidad', en: 'Speed', type: 'text' },
  { key: 'battery_health', es: 'Salud de batería', en: 'Battery health', type: 'number', unit: '%' },
  { key: 'has_charger', es: 'Incluye cargador', en: 'Includes charger', type: 'boolean' },
  { key: 'description', es: 'Descripción', en: 'Description', type: 'text' },
];

interface TypeDef {
  key: string; es: string; en: string; icon: string; tracksSerial?: boolean;
  // [atributo, {lot: describe la línea del lote, reqLot, reqTest}]
  attrs: [string, { lot?: boolean; reqLot?: boolean; reqTest?: boolean }?][];
}

const TYPES: TypeDef[] = [
  {
    key: 'laptop', es: 'Laptop', en: 'Laptop', icon: 'laptop',
    attrs: [
      ['brand', { lot: true, reqLot: true, reqTest: true }], ['model', { lot: true, reqLot: true, reqTest: true }],
      ['processor', { lot: true, reqTest: true }], ['generation', { lot: true }], ['ram', { lot: true, reqTest: true }],
      ['storage_type'], ['storage_size', { lot: true, reqTest: true }], ['screen_size'], ['battery_health'], ['has_charger'],
    ],
  },
  {
    key: 'desktop', es: 'Computadora de escritorio', en: 'Desktop', icon: 'pc-case',
    attrs: [
      ['brand', { lot: true, reqLot: true, reqTest: true }], ['model', { lot: true, reqLot: true, reqTest: true }],
      ['processor', { lot: true, reqTest: true }], ['generation', { lot: true }], ['ram', { lot: true, reqTest: true }],
      ['storage_type'], ['storage_size', { lot: true, reqTest: true }],
    ],
  },
  {
    key: 'monitor', es: 'Monitor', en: 'Monitor', icon: 'monitor',
    attrs: [
      ['brand', { lot: true, reqLot: true, reqTest: true }], ['model', { lot: true, reqLot: true, reqTest: true }],
      ['screen_size', { lot: true, reqTest: true }], ['resolution'],
    ],
  },
  {
    key: 'hard_drive', es: 'Disco duro', en: 'Hard drive', icon: 'hard-drive',
    attrs: [
      ['brand', { lot: true, reqLot: true }], ['model', { lot: true }], ['storage_type', { lot: true, reqTest: true }],
      ['storage_size', { lot: true, reqLot: true, reqTest: true }],
    ],
  },
  {
    key: 'memory', es: 'Memoria RAM', en: 'RAM module', icon: 'memory-stick',
    attrs: [
      ['brand', { lot: true }], ['ram', { lot: true, reqLot: true, reqTest: true }],
      ['ram_type', { lot: true, reqLot: true, reqTest: true }], ['memory_speed'],
    ],
  },
  {
    key: 'generic', es: 'Genérico (otro equipo)', en: 'Generic (other item)', icon: 'package',
    attrs: [['description', { lot: true, reqLot: true, reqTest: true }], ['brand', { lot: true }], ['model', { lot: true }]],
  },
];

export async function seedCompanyDefaults(db: Db, companyId: number): Promise<void> {
  const catalogIds = new Map<string, number>();
  let catOrder = 0;
  for (const c of CATALOGS) {
    const cat = await db.one<{ id: number }>(
      `INSERT INTO catalogs (company_id, key, name, is_system, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [companyId, c.key, JSON.stringify({ es: c.es, en: c.en }), !!c.system, catOrder++],
    );
    catalogIds.set(c.key, cat.id);
    let order = 0;
    for (const it of c.items) {
      await db.query(
        `INSERT INTO catalog_items (company_id, catalog_id, code, name, color, sort_order, system_key, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [companyId, cat.id, it.code ?? null, JSON.stringify({ es: it.es, en: it.en ?? it.es }), it.color ?? null, order++, it.systemKey ?? null, JSON.stringify(it.meta ?? {})],
      );
    }
  }

  const attrIds = new Map<string, number>();
  for (const a of ATTRIBUTES) {
    const r = await db.one<{ id: number }>(
      `INSERT INTO attribute_definitions (company_id, key, label, data_type, catalog_id, unit, is_system)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [companyId, a.key, JSON.stringify({ es: a.es, en: a.en }), a.type, a.catalog ? catalogIds.get(a.catalog)! : null, a.unit ?? null],
    );
    attrIds.set(a.key, r.id);
  }

  let typeOrder = 0;
  for (const t of TYPES) {
    const r = await db.one<{ id: number }>(
      `INSERT INTO equipment_types (company_id, key, name, icon, tracks_serial, is_system, sort_order)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
      [companyId, t.key, JSON.stringify({ es: t.es, en: t.en }), t.icon, t.tracksSerial ?? true, typeOrder++],
    );
    let order = 0;
    for (const [attrKey, opts] of t.attrs) {
      await db.query(
        `INSERT INTO equipment_type_attributes (company_id, equipment_type_id, attribute_id, sort_order, in_lot_line, required_on_lot, required_on_test)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, r.id, attrIds.get(attrKey)!, order++, !!opts?.lot, !!opts?.reqLot, !!opts?.reqTest],
      );
    }
  }

  await seedDefaultRoles(db, companyId);
  await markSalesScopeSeeded(db, companyId);
  await ensureDefaultLabelTemplate(db, companyId);
  await seedSystemReports(db, companyId);
  await markAssetsSeeded(db, companyId);
  await seedModelCatalogs(db, companyId);
  await seedProcessorGenerations(db, companyId);
  await seedImportAttributes(db, companyId);
  await seedDesktopFormFactor(db, companyId);
}

/** Una empresa nueva ya nace con "ver ventas de todos" decidido por rol: no hay que migrarle nada. */
async function markSalesScopeSeeded(db: Db, companyId: number): Promise<void> {
  await db.query(
    `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || '{"sales_scope": true}'::jsonb) WHERE id = $1`, [companyId]);
}

export async function seedDefaultRoles(db: Db, companyId: number): Promise<void> {
  for (const role of DEFAULT_ROLES) {
    const r = await db.one<{ id: number }>(
      `INSERT INTO roles (company_id, name, description) VALUES ($1,$2,$3) RETURNING id`,
      [companyId, role.name.es, role.description.es],
    );
    await db.query(
      `INSERT INTO role_permissions (company_id, role_id, permission_id)
       SELECT $1, $2, p.id FROM permissions p WHERE p.key = ANY($3::text[])`,
      [companyId, r.id, role.permissions],
    );
  }
}
