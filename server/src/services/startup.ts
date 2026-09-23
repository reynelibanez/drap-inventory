import pg from 'pg';
import { config } from '../config.js';
import { connectionOptions, withGlobal, withTenant } from '../db.js';
import { grantAppRole, migrate } from '../migrate.js';
import { ensureAssetDefaults } from './assetDefaults.js';
import { ensureDefaultLabelTemplate } from './labelDefaults.js';
import { ensureProcessorGenerations } from './generationDefaults.js';
import { ensureModelCatalogs } from './modelDefaults.js';
import { ensureImportAttributes, ensureDesktopFormFactor, ensureImportPermission } from './importDefaults.js';
import { ensurePricingDefaults } from './pricingDefaults.js';
import { ensureSalesScopeDefaults } from './salesScope.js';
import { SYSTEM_REPORTS, grantReportPermsToExistingRoles, seedSystemReports } from './reportDefaults.js';
import { invalidateAccessCache } from '../http.js';

interface Log { info: (m: string) => void; warn: (m: string) => void }

/**
 * Aplica al arrancar las migraciones de base de datos que falten (por ejemplo tras actualizar el sistema),
 * para que basta con reiniciar. Usa el usuario administrador del .env; si no se puede conectar, avisa y sigue.
 * Se desactiva con AUTO_MIGRATE=false.
 */
export async function applyPendingMigrations(log: Log): Promise<void> {
  if (process.env.AUTO_MIGRATE === 'false') return;
  const conn = new pg.Client(connectionOptions(config.db.adminUser, config.db.adminPassword));
  try {
    await conn.connect();
  } catch (e) {
    log.warn(`No se pudieron revisar las migraciones (no hubo conexión de administrador): ${(e as Error).message}`);
    return;
  }
  try {
    const res = await migrate(conn, (m) => log.info(m));
    if (res.applied.length) {
      await grantAppRole(conn, config.db.appUser);
      log.info(`Migraciones aplicadas: ${res.applied.join(', ')}`);
    }
  } finally {
    await conn.end();
  }
}

/** Datos iniciales que las empresas existentes deben tener tras una actualización (idempotente). */
export async function ensureCompanyDefaults(): Promise<void> {
  const companies = await withGlobal((db) => db.rows<{ id: number }>('SELECT id FROM companies ORDER BY id'));
  for (const c of companies) {
    await withTenant(c.id, async (db) => {
      await ensureDefaultLabelTemplate(db, c.id);
      await ensureAssetDefaults(db, c.id);
      await ensureModelCatalogs(db, c.id);
      await ensureProcessorGenerations(db, c.id);
      await ensureImportAttributes(db, c.id);
      await ensureDesktopFormFactor(db, c.id);
      await ensureImportPermission(db, c.id);
      await ensurePricingDefaults(db, c.id);
      await ensureSalesScopeDefaults(db, c.id);
      // Reportes de fábrica. Si la empresa no tenía ninguno (venía de una versión anterior), sus roles reciben también los permisos nuevos.
      const created = await seedSystemReports(db, c.id);
      if (created === SYSTEM_REPORTS.length) await grantReportPermsToExistingRoles(db);
    });
  }
  invalidateAccessCache();
}
