import pg from 'pg';

/** Crea una base de datos de pruebas limpia y aplica todas las migraciones. */
export default async function setup() {
  process.env.DB_NAME = 'refurbiz_test';
  const { config } = await import('../src/config.js');
  const { connectionOptions } = await import('../src/db.js');
  const { migrate, grantAppRole } = await import('../src/migrate.js');
  const { db } = config;

  const admin = new pg.Client(connectionOptions(db.adminUser, db.adminPassword, 'postgres'));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS refurbiz_test WITH (FORCE)`);
  await admin.query(`CREATE DATABASE refurbiz_test ENCODING 'UTF8' TEMPLATE template0`);
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [db.appUser]);
  if (!role.rowCount) {
    await admin.query(`CREATE ROLE ${admin.escapeIdentifier(db.appUser)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${admin.escapeLiteral(db.appPassword)}`);
  }
  await admin.end();

  const conn = new pg.Client(connectionOptions(db.adminUser, db.adminPassword, 'refurbiz_test'));
  await conn.connect();
  await conn.query(`GRANT CONNECT ON DATABASE refurbiz_test TO ${conn.escapeIdentifier(db.appUser)}`);
  await migrate(conn);
  await grantAppRole(conn, db.appUser);
  await conn.end();
}
