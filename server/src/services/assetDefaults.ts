import type { Db } from '../db.js';

/** Estados de los activos de la empresa (herramientas y equipos propios). `systemKey` = valores de los que depende la lógica. */
export const ASSET_STATUS_CATALOG = {
  es: 'Estados de activo', en: 'Asset statuses', system: true,
  items: [
    { systemKey: 'in_use', es: 'En uso', en: 'In use', color: '#16a34a' },
    { systemKey: 'stored', es: 'Guardado', en: 'In storage', color: '#2563eb' },
    { systemKey: 'repair', es: 'En reparación', en: 'In repair', color: '#f59e0b' },
    { systemKey: 'retired', es: 'Dado de baja', en: 'Retired', color: '#6b7280' },
  ],
};

/** Marca de que los datos iniciales de "Activos" ya se aplicaron a la empresa (para no repetir permisos que el administrador quitó). */
export async function markAssetsSeeded(db: Db, companyId: number): Promise<void> {
  await db.query(
    `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || '{"assets": true}'::jsonb) WHERE id = $1`,
    [companyId]);
}

/**
 * Empresas creadas antes de existir "Activos": crea el catálogo de estados y, una sola vez, da acceso a los roles que ya
 * trabajaban con equipos (ver activos) o administraban (gestionar activos). Idempotente.
 */
export async function ensureAssetDefaults(db: Db, companyId: number): Promise<void> {
  const cat = await db.opt<{ id: number }>(`SELECT id FROM catalogs WHERE key = 'asset_status'`);
  if (!cat) {
    const order = await db.one<{ n: number }>('SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM catalogs');
    const c = await db.one<{ id: number }>(
      `INSERT INTO catalogs (company_id, key, name, is_system, sort_order) VALUES ($1,'asset_status',$2,true,$3) RETURNING id`,
      [companyId, JSON.stringify({ es: ASSET_STATUS_CATALOG.es, en: ASSET_STATUS_CATALOG.en }), order.n]);
    let i = 0;
    for (const it of ASSET_STATUS_CATALOG.items) {
      await db.query(
        `INSERT INTO catalog_items (company_id, catalog_id, name, color, sort_order, system_key) VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, c.id, JSON.stringify({ es: it.es, en: it.en }), it.color, i++, it.systemKey]);
    }
  }

  const seeded = await db.opt<{ done: boolean }>(`SELECT COALESCE((settings->'_seeded'->>'assets')::boolean, false) AS done FROM companies WHERE id = $1`, [companyId]);
  if (seeded?.done) return;
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'assets.view'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'units.view')
        AND (NOT EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'sales.create')
             OR EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'users.manage'))
     ON CONFLICT DO NOTHING`);
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key = 'assets.manage'
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key IN ('users.manage', 'locations.manage'))
     ON CONFLICT DO NOTHING`);
  await markAssetsSeeded(db, companyId);
}
