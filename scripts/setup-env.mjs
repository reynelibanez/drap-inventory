// Crea el archivo .env pidiendo solo lo necesario. Sin dependencias: corre antes de "npm install".
// Uso: node scripts/setup-env.mjs            (interactivo)
//      node scripts/setup-env.mjs --force    (vuelve a crearlo)
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_NAME_HELP, DEFAULT_DB_NAME, appUserFor, cleanDbName, dbNameFromArgs } from './db-names.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(rootDir, '.env');
if (existsSync(file) && !process.argv.includes('--force')) {
  console.log('Ya existe el archivo .env; se conserva (usa --force para crearlo de nuevo).');
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = function (s) { if (!muted || s.includes('\n')) rl.output.write(s); };
const ask = (q, def, secret = false) => new Promise((res) => {
  rl.question(`${q}${def ? ` [${def}]` : ''}: `, (a) => { muted = false; if (secret) console.log(); res(a.trim() || def || ''); });
  muted = secret;
});
const q = (v) => (/[\s#"'\\$]/.test(v) ? (v.includes("'") ? `"${v}"` : `'${v}'`) : v);

/** De la URL o el subdominio de un proyecto de Supabase, saca su referencia (ej: "bqrdxwxnnaggemdllvkr"). */
export function parseSupabaseRef(raw) {
  const v = String(raw ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.supabase\.co$/i, '');
  return /^[a-z0-9]+$/i.test(v) ? v.toLowerCase() : null;
}

console.log('\n=== Configuracion de la conexion a la base de datos ===');

const givenDbName = dbNameFromArgs();
let useSupabase = false;
// Instalaciones sin preguntas (--db=NOMBRE o DRAP_DB_NAME) siguen yendo directo a PostgreSQL local, como antes.
if (!givenDbName && process.stdin.isTTY) {
  console.log('\n¿Donde va a vivir la base de datos?');
  console.log('  1) PostgreSQL en esta maquina o en el servidor (por defecto)');
  console.log('  2) Supabase (base de datos en la nube, no hay que instalar ni mantener nada)\n');
  useSupabase = (await ask('Elige 1 o 2', '1')).trim() === '2';
}

let host, port, adminUser, adminPass, dbName, appUser, dbNameComment, ssl = false;

if (useSupabase) {
  console.log('\nEntra a tu proyecto en supabase.com y copia la URL que ves en el navegador');
  console.log('(o en Project Settings -> General -> Reference ID).\n');
  let ref = null;
  while (!ref) {
    ref = parseSupabaseRef(await ask('URL o referencia del proyecto de Supabase (ej: https://xxxxxxxx.supabase.co)'));
    if (!ref) console.log('  No reconoci esa URL. Pega la direccion completa que aparece en el navegador dentro del proyecto.');
  }
  console.log('\nAhora la contrasena de la base de datos: Project Settings -> Database -> Database password.');
  console.log('OJO: no es la contrasena con la que entras a supabase.com, es otra distinta.\n');
  adminPass = '';
  while (!adminPass) adminPass = await ask('Contrasena de la base de datos de Supabase', undefined, true);
  host = `db.${ref}.supabase.co`;
  port = '5432';
  adminUser = 'postgres';
  dbName = 'postgres';
  dbNameComment = '# Supabase: la base ya existe y siempre se llama "postgres" (no se crea una nueva).';
  appUser = 'drapsystems_app';
  ssl = true;
} else {
  console.log('\nEs el usuario administrador de PostgreSQL (el que definiste al instalarlo; normalmente "postgres").\n');
  host = await ask('Servidor de PostgreSQL', 'localhost');
  port = await ask('Puerto de PostgreSQL', '5432');
  adminUser = await ask('Usuario administrador', 'postgres');
  adminPass = '';
  while (!adminPass) adminPass = await ask('Contrasena de ese usuario', undefined, true);
  dbName = givenDbName;
  while (!dbName) {
    dbName = cleanDbName(await ask('Nombre de la base de datos que se creara', DEFAULT_DB_NAME));
    if (!dbName) console.log(`  Nombre no valido. ${DB_NAME_HELP}`);
  }
  dbNameComment = '# Nombre de la base de datos. Se crea al instalar; si lo cambias despues, se creara una base nueva y vacia.';
  appUser = appUserFor(dbName);
}
const webPort = await ask('Puerto en el que se abrira el sistema', '3000');
rl.close();

const env = [
  '# Generado por scripts/setup-env.mjs',
  'NODE_ENV=production',
  `PORT=${webPort}`,
  `JWT_SECRET=${randomBytes(48).toString('hex')}`,
  '# En la PC se usa http (sin certificado). En un VPS con HTTPS cambia a true.',
  'COOKIE_SECURE=false',
  '',
  ...(useSupabase ? ['# Conexion directa (no la de "connection pooling"): las migraciones la necesitan.'] : []),
  `DB_HOST=${host}`,
  `DB_PORT=${port}`,
  dbNameComment,
  `DB_NAME=${dbName}`,
  `DB_ADMIN_USER=${adminUser}`,
  `DB_ADMIN_PASSWORD=${q(adminPass)}`,
  '# Usuario con el que trabaja la aplicacion (se crea solo, sin privilegios de administrador)',
  `DB_APP_USER=${appUser}`,
  `DB_APP_PASSWORD=${randomBytes(18).toString('hex')}`,
  ...(ssl ? ['DB_SSL=true'] : []),
  '',
].join('\n');
writeFileSync(file, env, { mode: 0o600 });
console.log('\nArchivo .env creado.\n');

// Si las dependencias ya estan instaladas, de una vez crea las tablas (para no tener que correr
// "npm run db:setup" aparte). En una instalacion desde cero (sin node_modules todavia) o cuando
// llama el instalador guiado (que ya hace este paso el solo mas adelante, con "--no-db-setup"),
// se salta esto.
if (!process.argv.includes('--no-db-setup') && existsSync(resolve(rootDir, 'node_modules'))) {
  console.log('Creando las tablas en la base de datos...\n');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['run', 'db:setup'], { cwd: rootDir, stdio: 'inherit' });
  if (r.status !== 0) {
    console.log('\n[X] El archivo .env quedo listo, pero no se pudieron crear las tablas. Revisa el mensaje de arriba y despues corre: npm run db:setup\n');
    process.exit(1);
  }
  console.log('\nListo: conexion configurada y base de datos creada.\n');
}
