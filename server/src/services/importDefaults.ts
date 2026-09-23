import type { Db } from '../db.js';
import { isSeeded, setSeeded } from './modelDefaults.js';

/**
 * Campos que agrega la importación de equipos por CSV (sistema operativo, estado de batería, pantalla táctil):
 * no existían antes en el catálogo de "Laptop". Se agregan una sola vez por empresa (nueva o existente), sin
 * tocar nada que la empresa ya haya personalizado.
 */

interface I18n { es: string; en: string }
interface AttrDef { key: string; es: string; en: string; dataType: 'select' | 'boolean'; catalogKey?: string; catalogItems?: I18n[] }

const ATTR_DEFS: AttrDef[] = [
  {
    key: 'os', es: 'Sistema operativo', en: 'Operating system', dataType: 'select', catalogKey: 'os',
    catalogItems: [
      { es: 'Windows 10 Home', en: 'Windows 10 Home' }, { es: 'Windows 10 Pro', en: 'Windows 10 Pro' },
      { es: 'Windows 11 Home', en: 'Windows 11 Home' }, { es: 'Windows 11 Pro', en: 'Windows 11 Pro' },
      { es: 'macOS', en: 'macOS' }, { es: 'Chrome OS', en: 'Chrome OS' }, { es: 'Linux', en: 'Linux' },
      { es: 'Sin sistema operativo', en: 'No operating system' },
    ],
  },
  {
    key: 'battery_condition', es: 'Estado de batería', en: 'Battery condition', dataType: 'select', catalogKey: 'battery_condition',
    catalogItems: [
      { es: 'Excelente', en: 'Excellent' }, { es: 'Bueno', en: 'Good' }, { es: 'Regular', en: 'Fair' }, { es: 'Malo', en: 'Poor' },
    ],
  },
  { key: 'touch_screen', es: 'Pantalla táctil', en: 'Touch screen', dataType: 'boolean' },
];

async function ensureCatalog(db: Db, companyId: number, key: string, name: I18n): Promise<number> {
  const found = await db.opt<{ id: number }>('SELECT id FROM catalogs WHERE key = $1', [key]);
  if (found) return found.id;
  const r = await db.one<{ id: number }>(
    `INSERT INTO catalogs (company_id, key, name, sort_order) VALUES ($1,$2,$3,(SELECT COALESCE(max(sort_order),0)+1 FROM catalogs)) RETURNING id`,
    [companyId, key, JSON.stringify(name)]);
  return r.id;
}

/** Crea (si faltan) los atributos "Sistema operativo", "Estado de batería" y "Pantalla táctil", y los agrega al tipo "Laptop". Idempotente. */
export async function seedImportAttributes(db: Db, companyId: number): Promise<void> {
  const laptop = await db.opt<{ id: number }>(`SELECT id FROM equipment_types WHERE key = 'laptop'`);
  let order = laptop
    ? (await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM equipment_type_attributes WHERE equipment_type_id = $1', [laptop.id])).n
    : 0;

  for (const a of ATTR_DEFS) {
    let catalogId: number | null = null;
    if (a.catalogKey) {
      catalogId = await ensureCatalog(db, companyId, a.catalogKey, { es: a.es, en: a.en });
      for (const it of a.catalogItems ?? []) {
        await db.query(
          `INSERT INTO catalog_items (company_id, catalog_id, name, sort_order)
           SELECT $1, $2, $3::jsonb, (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $2)
            WHERE NOT EXISTS (SELECT 1 FROM catalog_items WHERE catalog_id = $2
                                AND (lower(name->>'es') = lower($4::text) OR lower(name->>'en') = lower($5::text)))`,
          [companyId, catalogId, JSON.stringify({ es: it.es, en: it.en }), it.es, it.en]);
      }
    }

    let attr = await db.opt<{ id: number }>('SELECT id FROM attribute_definitions WHERE key = $1', [a.key]);
    if (!attr) {
      const r = await db.one<{ id: number }>(
        `INSERT INTO attribute_definitions (company_id, key, label, data_type, catalog_id, is_system) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [companyId, a.key, JSON.stringify({ es: a.es, en: a.en }), a.dataType, catalogId]);
      attr = { id: r.id };
    }

    if (laptop) {
      const linked = await db.opt('SELECT 1 FROM equipment_type_attributes WHERE equipment_type_id = $1 AND attribute_id = $2', [laptop.id, attr.id]);
      if (!linked) {
        await db.query(
          `INSERT INTO equipment_type_attributes (company_id, equipment_type_id, attribute_id, sort_order, in_lot_line, required_on_lot, required_on_test)
           VALUES ($1,$2,$3,$4,false,false,false)`, [companyId, laptop.id, attr.id, order++]);
      }
    }
  }
  await setSeeded(db, companyId, 'importAttributes');
}

/** Empresas creadas antes de que existieran estos campos: los agregan una sola vez. */
export async function ensureImportAttributes(db: Db, companyId: number): Promise<void> {
  if (!(await isSeeded(db, companyId, 'importAttributes'))) await seedImportAttributes(db, companyId);
}

/**
 * Campo que agrega la importación desde el formato "control técnico" (con columna de tipo de equipo: laptop,
 * micro, SFF...): el "factor de forma" no existía antes en el catálogo de "Computadora de escritorio".
 * Se agrega una sola vez por empresa, sin tocar nada que la empresa ya haya personalizado.
 */
const FORM_FACTOR_ITEMS: I18n[] = [
  { es: 'Micro', en: 'Micro' }, { es: 'SFF (formato reducido)', en: 'SFF (small form factor)' },
  { es: 'Torre', en: 'Tower' }, { es: 'Todo en uno', en: 'All-in-one' },
];

/** Crea (si falta) el atributo "Factor de forma" y lo agrega al tipo "Computadora de escritorio". Idempotente. */
export async function seedDesktopFormFactor(db: Db, companyId: number): Promise<void> {
  const desktop = await db.opt<{ id: number }>(`SELECT id FROM equipment_types WHERE key = 'desktop'`);
  const catalogId = await ensureCatalog(db, companyId, 'form_factor', { es: 'Factor de forma', en: 'Form factor' });
  for (const it of FORM_FACTOR_ITEMS) {
    await db.query(
      `INSERT INTO catalog_items (company_id, catalog_id, name, sort_order)
       SELECT $1, $2, $3::jsonb, (SELECT COALESCE(max(sort_order), -1) + 1 FROM catalog_items WHERE catalog_id = $2)
        WHERE NOT EXISTS (SELECT 1 FROM catalog_items WHERE catalog_id = $2
                            AND (lower(name->>'es') = lower($4::text) OR lower(name->>'en') = lower($5::text)))`,
      [companyId, catalogId, JSON.stringify({ es: it.es, en: it.en }), it.es, it.en]);
  }

  let attr = await db.opt<{ id: number }>(`SELECT id FROM attribute_definitions WHERE key = 'form_factor'`);
  if (!attr) {
    const r = await db.one<{ id: number }>(
      `INSERT INTO attribute_definitions (company_id, key, label, data_type, catalog_id, is_system) VALUES ($1,'form_factor',$2,'select',$3,true) RETURNING id`,
      [companyId, JSON.stringify({ es: 'Factor de forma', en: 'Form factor' }), catalogId]);
    attr = { id: r.id };
  }

  if (desktop) {
    const linked = await db.opt('SELECT 1 FROM equipment_type_attributes WHERE equipment_type_id = $1 AND attribute_id = $2', [desktop.id, attr.id]);
    if (!linked) {
      const order = (await db.one<{ n: number }>(
        'SELECT COALESCE(max(sort_order), -1) + 1 AS n FROM equipment_type_attributes WHERE equipment_type_id = $1', [desktop.id])).n;
      await db.query(
        `INSERT INTO equipment_type_attributes (company_id, equipment_type_id, attribute_id, sort_order, in_lot_line, required_on_lot, required_on_test)
         VALUES ($1,$2,$3,$4,false,false,false)`, [companyId, desktop.id, attr.id, order]);
    }
  }
  await setSeeded(db, companyId, 'techImportAttributes');
}

/** Empresas creadas antes de que existiera este campo: lo agregan una sola vez. */
export async function ensureDesktopFormFactor(db: Db, companyId: number): Promise<void> {
  if (!(await isSeeded(db, companyId, 'techImportAttributes'))) await seedDesktopFormFactor(db, companyId);
}

/**
 * Empresas creadas antes de que "Importar equipos desde un archivo CSV" fuera un permiso propio: una sola vez,
 * los roles que ya administran usuarios (los administradores) lo reciben. Después el administrador lo activa o
 * quita por rol o por usuario en Roles y permisos. Idempotente.
 */
export async function ensureImportPermission(db: Db, companyId: number): Promise<void> {
  if (await isSeeded(db, companyId, 'lotsImportPermission')) return;
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'lots.import'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'users.manage')
     ON CONFLICT DO NOTHING`);
  await setSeeded(db, companyId, 'lotsImportPermission');
}
