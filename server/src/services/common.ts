import type { Db } from '../db.js';
import type { AppLanguage } from '../config.js';
import { AppError } from '../errors.js';

/** Id del valor de catálogo con clave de sistema (ej. unit_status → available). */
export async function sysItemId(db: Db, catalogKey: string, systemKey: string): Promise<number> {
  const r = await db.opt<{ id: number }>(
    `SELECT ci.id FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id
      WHERE c.key = $1 AND ci.system_key = $2`, [catalogKey, systemKey]);
  if (!r) throw new AppError(500, 'system_item_missing', { catalog: catalogKey, key: systemKey });
  return r.id;
}

/** Mapa id → systemKey de un catálogo de sistema. */
export async function sysKeys(db: Db, catalogKey: string): Promise<Map<number, string>> {
  const rows = await db.rows<{ id: number; system_key: string }>(
    `SELECT ci.id, ci.system_key FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id
      WHERE c.key = $1 AND ci.system_key IS NOT NULL`, [catalogKey]);
  return new Map(rows.map((r) => [r.id, r.system_key]));
}

/** Verifica que un valor de catálogo exista, esté activo y pertenezca al catálogo indicado. */
export async function assertCatalogItem(db: Db, itemId: number | null | undefined, catalogKey: string, code: string): Promise<{ id: number; meta: Record<string, unknown> } | null> {
  if (itemId === null || itemId === undefined) return null;
  const r = await db.opt<{ id: number; meta: Record<string, unknown> }>(
    `SELECT ci.id, ci.meta FROM catalog_items ci JOIN catalogs c ON c.id = ci.catalog_id
      WHERE ci.id = $1 AND c.key = $2 AND ci.is_active`, [itemId, catalogKey]);
  if (!r) throw new AppError(400, 'invalid_catalog_value', { field: code });
  return r;
}

/** Registra un cambio en el historial de un equipo (y auditoría general). */
export type AuditFn = (action: string, entity: string, entityId: number | null, data?: Record<string, unknown>) => Promise<void>;

export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

/**
 * Bloquea filas por id ANTES de leer con joins. Si se hace `SELECT ... JOIN ... FOR UPDATE`, al esperar el
 * bloqueo PostgreSQL vuelve a evaluar el join con versiones viejas de las otras tablas y puede descartar
 * la fila en silencio. Bloquear primero y leer después evita ese problema.
 */
export async function lockRows(db: Db, table: 'units' | 'lots' | 'sales_orders' | 'slots', ids: number[]): Promise<void> {
  if (ids.length) await db.query(`SELECT id FROM ${table} WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids]);
}

/**
 * Idioma de la empresa. Todo documento que genera el sistema (PDF, etiquetas, reportes, exportaciones) sale en este idioma,
 * sin importar el idioma que use en pantalla quien lo pide.
 */
export async function companyLanguage(db: Db, companyId: number): Promise<AppLanguage> {
  const r = await db.opt<{ default_language: string }>('SELECT default_language FROM companies WHERE id = $1', [companyId]);
  return r?.default_language === 'en' ? 'en' : 'es';
}
