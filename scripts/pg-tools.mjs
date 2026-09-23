// Utilidades compartidas por backup.mjs y restore.mjs (sin dependencias).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function readEnv() {
  const file = join(ROOT, '.env');
  const env = { ...process.env };
  if (existsSync(file)) {
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || raw.trim().startsWith('#')) continue;
      let v = m[2];
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      if (env[m[1]] === undefined) env[m[1]] = v;
    }
  }
  return env;
}

/** Busca pg_dump / pg_restore en el PATH y, en Windows, en las carpetas de instalacion de PostgreSQL. */
export function findPgTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = join(ROOT, 'runtime', 'pgsql', 'bin', exe);       // PostgreSQL incluido en el paquete de produccion
  if (existsSync(bundled)) return bundled;
  if (spawnSync(exe, ['--version'], { stdio: 'ignore' }).status === 0) return exe;
  if (process.platform === 'win32') {
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const pg = join(base, 'PostgreSQL');
      if (!existsSync(pg)) continue;
      const versions = readdirSync(pg).sort((a, b) => Number(b) - Number(a));
      for (const v of versions) {
        const p = join(pg, v, 'bin', exe);
        if (existsSync(p)) return p;
      }
    }
  }
  console.error(`No se encontro ${exe}. Instala las herramientas de linea de comandos de PostgreSQL o agrega su carpeta "bin" al PATH.`);
  process.exit(1);
}

export function conn(env) {
  return {
    host: env.DB_HOST || 'localhost', port: env.DB_PORT || '5432', db: env.DB_NAME || 'refurbiz',
    user: env.DB_ADMIN_USER || 'postgres', pass: env.DB_ADMIN_PASSWORD || '',
  };
}
