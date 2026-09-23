// Copia de seguridad completa de la base de datos -> carpeta "backups".
// Uso: npm run backup
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT, conn, findPgTool, readEnv } from './pg-tools.mjs';

const env = readEnv();
const c = conn(env);
const dir = join(ROOT, 'backups');
mkdirSync(dir, { recursive: true });
const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const file = join(dir, `${c.db}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.dump`);

const r = spawnSync(findPgTool('pg_dump'), ['-h', c.host, '-p', c.port, '-U', c.user, '-d', c.db, '-Fc', '--no-owner', '--no-privileges', '-f', file], {
  stdio: 'inherit', env: { ...process.env, PGPASSWORD: c.pass },
});
if (r.status !== 0) { console.error('\nNo se pudo crear la copia de seguridad.'); process.exit(1); }
console.log(`\nCopia creada: ${file}`);
