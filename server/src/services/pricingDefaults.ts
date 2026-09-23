import type { Db } from '../db.js';

/**
 * Empresas creadas antes de existir los costos y precios de lista: una sola vez, los roles que administran usuarios
 * (los administradores) reciben los permisos nuevos. Después el administrador decide a quién dárselos. Idempotente.
 */
export async function ensurePricingDefaults(db: Db, companyId: number): Promise<void> {
  const seeded = await db.opt<{ done: boolean }>(`SELECT COALESCE((settings->'_seeded'->>'pricing')::boolean, false) AS done FROM companies WHERE id = $1`, [companyId]);
  if (seeded?.done) return;
  await db.query(
    `INSERT INTO role_permissions (company_id, role_id, permission_id)
     SELECT r.company_id, r.id, p.id FROM roles r CROSS JOIN permissions p
      WHERE p.key IN ('costs.view', 'costs.manage', 'prices.manage')
        AND EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions x ON x.id = rp.permission_id WHERE rp.role_id = r.id AND x.key = 'users.manage')
     ON CONFLICT DO NOTHING`);
  await db.query(
    `UPDATE companies SET settings = settings || jsonb_build_object('_seeded', COALESCE(settings->'_seeded', '{}'::jsonb) || '{"pricing": true}'::jsonb) WHERE id = $1`, [companyId]);
}
