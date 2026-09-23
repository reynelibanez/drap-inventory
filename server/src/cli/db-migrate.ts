/** Aplica migraciones pendientes (la base y el usuario de la app ya deben existir). */
import pg from 'pg';
import { config } from '../config.js';
import { connectionOptions } from '../db.js';
import { grantAppRole, migrate } from '../migrate.js';

async function main() {
  const conn = new pg.Client(connectionOptions(config.db.adminUser, config.db.adminPassword));
  await conn.connect();
  try {
    const res = await migrate(conn, console.log);
    await grantAppRole(conn, config.db.appUser);
    console.log(res.applied.length ? `Migraciones aplicadas: ${res.applied.length}` : 'Sin migraciones pendientes.');
  } finally {
    await conn.end();
  }
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
