/**
 * Prepara la base de datos desde cero (o la deja al día si ya existe):
 *  1) crea el usuario de la app (sin privilegios de superusuario) y la base,
 *  2) aplica las migraciones,
 *  3) otorga permisos de datos al usuario de la app.
 * Es seguro ejecutarlo varias veces.
 */
import pg from 'pg';
import { config } from '../config.js';
import { connectionOptions } from '../db.js';
import { grantAppRole, migrate } from '../migrate.js';

const { db } = config;

async function main() {
  console.log(`Conectando a PostgreSQL en ${db.host}:${db.port} como ${db.adminUser}...`);
  const admin = new pg.Client(connectionOptions(db.adminUser, db.adminPassword, 'postgres'));
  await admin.connect();

  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [db.appUser]);
  if (role.rowCount === 0) {
    console.log(`Creando usuario de la aplicación "${db.appUser}"...`);
    await admin.query(
      `CREATE ROLE ${admin.escapeIdentifier(db.appUser)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ${admin.escapeLiteral(db.appPassword)}`,
    );
  } else {
    // Mantiene la contraseña sincronizada con el .env
    await admin.query(`ALTER ROLE ${admin.escapeIdentifier(db.appUser)} PASSWORD ${admin.escapeLiteral(db.appPassword)} NOBYPASSRLS NOSUPERUSER`);
  }

  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.database]);
  if (exists.rowCount === 0) {
    console.log(`Creando base de datos "${db.database}"...`);
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(db.database)} ENCODING 'UTF8' TEMPLATE template0`);
  }
  await admin.end();

  const conn = new pg.Client(connectionOptions(db.adminUser, db.adminPassword));
  await conn.connect();
  try {
    await conn.query(`GRANT CONNECT ON DATABASE ${conn.escapeIdentifier(db.database)} TO ${conn.escapeIdentifier(db.appUser)}`);
    const res = await migrate(conn, console.log);
    await grantAppRole(conn, db.appUser);
    console.log(res.applied.length ? `Migraciones aplicadas: ${res.applied.length}` : 'La base de datos ya estaba al día.');
  } finally {
    await conn.end();
  }
  console.log('Base de datos lista.');
}

main().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
