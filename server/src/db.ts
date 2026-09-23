import pg from 'pg';
import { config } from './config.js';

// bigint → number (los ids caben de sobra), numeric → number (montos con 2 decimales).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// bigint[] → number[] (por ejemplo array_agg de ids); sin esto llegan como texto y las comparaciones fallan.
const parseInt8Array = pg.types.getTypeParser(1016 as any) as (v: string) => string[];
pg.types.setTypeParser(1016 as any, (v: string) => parseInt8Array(v).map(Number));
// Las fechas (sin hora) se devuelven como texto AAAA-MM-DD para evitar corrimientos por zona horaria.
pg.types.setTypeParser(1082, (v) => v);

export function connectionOptions(user: string, password: string, database = config.db.database): pg.PoolConfig {
  return {
    host: config.db.host,
    port: config.db.port,
    database,
    user,
    password,
    ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

export const pool = new pg.Pool({
  ...connectionOptions(config.db.appUser, config.db.appPassword),
  max: 12,
  idleTimeoutMillis: 30_000,
});

/** Envoltorio mínimo sobre un cliente de PostgreSQL con atajos de lectura. */
export class Db {
  constructor(readonly client: pg.PoolClient | pg.Client) {}

  query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return this.client.query<T>(sql, params as any[]);
  }
  async rows<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.query<T>(sql, params)).rows;
  }
  async opt<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.query<T>(sql, params)).rows[0] ?? null;
  }
  async one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.opt<T>(sql, params);
    if (!r) throw new Error('Se esperaba una fila y no se encontró ninguna');
    return r;
  }
}

async function run<T>(fn: (db: Db) => Promise<T>, companyId: number | null): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (companyId !== null) {
      // Local a la transacción: al terminar, la conexión vuelve limpia al pool.
      await client.query("SELECT set_config('app.company_id', $1, true)", [String(companyId)]);
    }
    const result = await fn(new Db(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* conexión perdida */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Transacción dentro de UNA empresa: PostgreSQL solo deja ver/editar filas de esa empresa. */
export function withTenant<T>(companyId: number, fn: (db: Db) => Promise<T>): Promise<T> {
  return run(fn, companyId);
}

/** Transacción sin empresa (capa de identidad: usuarios, empresas, sesiones). */
export function withGlobal<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return run(fn, null);
}
