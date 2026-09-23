// Crea el archivo .env pidiendo solo lo necesario. Sin dependencias: corre antes de "npm install".
// Uso: node scripts/setup-env.mjs            (interactivo)
//      node scripts/setup-env.mjs --force    (vuelve a crearlo)
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_NAME_HELP, DEFAULT_DB_NAME, appUserFor, cleanDbName, dbNameFromArgs } from './db-names.mjs';

const file = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');
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

console.log('\n=== Configuracion de la conexion a PostgreSQL ===');
console.log('Es el usuario administrador de PostgreSQL (el que definiste al instalarlo; normalmente "postgres").\n');
const host = await ask('Servidor de PostgreSQL', 'localhost');
const port = await ask('Puerto de PostgreSQL', '5432');
const adminUser = await ask('Usuario administrador', 'postgres');
let adminPass = '';
while (!adminPass) adminPass = await ask('Contrasena de ese usuario', undefined, true);
let dbName = dbNameFromArgs();
while (!dbName) {
  dbName = cleanDbName(await ask('Nombre de la base de datos que se creara', DEFAULT_DB_NAME));
  if (!dbName) console.log(`  Nombre no valido. ${DB_NAME_HELP}`);
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
  `DB_HOST=${host}`,
  `DB_PORT=${port}`,
  '# Nombre de la base de datos. Se crea al instalar; si lo cambias despues, se creara una base nueva y vacia.',
  `DB_NAME=${dbName}`,
  `DB_ADMIN_USER=${adminUser}`,
  `DB_ADMIN_PASSWORD=${q(adminPass)}`,
  '# Usuario con el que trabaja la aplicacion (se crea solo, sin privilegios de administrador)',
  `DB_APP_USER=${appUserFor(dbName)}`,
  `DB_APP_PASSWORD=${randomBytes(18).toString('hex')}`,
  '',
].join('\n');
writeFileSync(file, env, { mode: 0o600 });
console.log('\nArchivo .env creado.\n');
