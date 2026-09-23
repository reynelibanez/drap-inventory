// Restaura una copia de seguridad en la base configurada en .env (por ejemplo, al migrar a un VPS).
// Uso: npm run restore -- backups/refurbiz-20260918-1030.dump
// Reemplaza el contenido actual de la base. Requiere haber ejecutado antes "npm run build".
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ROOT, conn, findPgTool, readEnv } from './pg-tools.mjs';

const file = process.argv[2] && resolve(process.argv[2]);
if (!file || !existsSync(file)) { console.error('Indica el archivo de la copia:  npm run restore -- backups/archivo.dump'); process.exit(1); }
const env = readEnv();
const c = conn(env);
const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...env, PGPASSWORD: c.pass }, ...extra });
  if (r.status !== 0) { console.error(`\nFallo: ${cmd} ${args.join(' ')}`); process.exit(1); }
  return r;
};

console.log('1/3 Preparando base de datos y usuario de la aplicacion...');
run(process.execPath, [join('server', 'dist', 'cli', 'db-setup.js')]);
console.log('\n2/3 Restaurando la copia (reemplaza los datos actuales)...');
// pg_restore avisa de objetos que "no existen" al limpiar; es normal, por eso no se exige codigo 0.
spawnSync(findPgTool('pg_restore'), ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.db, '--clean', '--if-exists', '--no-owner', '--no-privileges', file],
  { stdio: 'inherit', env: { ...process.env, PGPASSWORD: c.pass } });
console.log('\n3/3 Aplicando migraciones pendientes y permisos...');
run(process.execPath, [join('server', 'dist', 'cli', 'db-migrate.js')]);
console.log('\nListo. Inicia el sistema con:  npm start');
