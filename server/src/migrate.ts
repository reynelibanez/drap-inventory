import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '..', 'migrations');

export interface MigrateResult { applied: string[]; alreadyApplied: number }

/**
 * Aplica las migraciones SQL pendientes, en orden y cada una en su transacción.
 * Un candado de sesión evita que dos procesos migren a la vez.
 * Ya aplicadas se verifican por checksum: editar una migración vieja es un error.
 */
export async function migrate(client: Client, log: (m: string) => void = () => {}): Promise<MigrateResult> {
  await client.query('SELECT pg_advisory_lock(727274)');
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== checksum) throw new Error(`La migración ${file} ya se aplicó y fue modificada. Crea una migración nueva en lugar de editarla.`);
        continue;
      }
      log(`  → aplicando ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    return { applied, alreadyApplied: done.size };
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)');
  }
}

/** Da al usuario de la app permisos de datos (nunca de esquema) sobre lo migrado. */
export async function grantAppRole(client: Client, role: string): Promise<void> {
  const r = client.escapeIdentifier(role);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);
  await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`);
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${r}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${r}`);
}
