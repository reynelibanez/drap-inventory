// PostgreSQL incluido en el paquete de produccion (runtime/pgsql): no hace falta instalar PostgreSQL en la maquina.
// Uso (lo llaman instalar/iniciar/detener .bat y .sh):
//   node scripts/local-pg.mjs init     crea la base de datos local (una sola vez) y el archivo .env si no existe.
//                                       Pregunta el nombre de la base (Enter = drap_inventory); o indicalo con --db=NOMBRE / DRAP_DB_NAME.
//   node scripts/local-pg.mjs start    la enciende si esta apagada
//   node scripts/local-pg.mjs stop     la apaga
//   node scripts/local-pg.mjs status
// Los datos quedan en la carpeta "data/pg" (respaldala o copiala junto con el resto). Solo acepta conexiones de la misma maquina.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DB_NAME_HELP, DEFAULT_DB_NAME, appUserFor, cleanDbName, dbNameFromArgs } from './db-names.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PGROOT = process.env.DRAP_PG_ROOT ? resolve(process.env.DRAP_PG_ROOT) : join(ROOT, 'runtime', 'pgsql');
const DATA = join(ROOT, 'data', 'pg');
const LOG = join(ROOT, 'data', 'pg.log');
const ENV_FILE = join(ROOT, '.env');
const EXT = process.platform === 'win32' ? '.exe' : '';
const bin = (n) => join(PGROOT, 'bin', n + EXT);
const DEFAULT_PORT = '5433';        // distinto del 5432 habitual, por si la maquina ya tiene otro PostgreSQL

function fail(msg) { console.error(`\n[X] ${msg}\n`); process.exit(1); }

if (!existsSync(bin('pg_ctl'))) fail(`Este paquete no incluye PostgreSQL (falta ${bin('pg_ctl')}).`);

/** Lee el .env para tomar el puerto elegido. */
function envValue(name) {
  if (!existsSync(ENV_FILE)) return undefined;
  const m = readFileSync(ENV_FILE, 'utf8').match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : undefined;
}
const port = () => envValue('DB_PORT') || DEFAULT_PORT;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return r;
}

function isRunning() { return run(bin('pg_ctl'), ['status', '-D', DATA]).status === 0; }

/** Nombre de la base de datos: el indicado (--db / DRAP_DB_NAME), o se pregunta (Enter acepta el sugerido). Sin consola interactiva: el sugerido. */
async function chooseDbName() {
  const given = dbNameFromArgs();
  if (given) return given;
  if (!process.stdin.isTTY) return DEFAULT_DB_NAME;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  console.log('\nNombre de la base de datos (donde se guardan todos los datos del sistema).');
  console.log('Puedes dejar el sugerido: solo presiona Enter.\n');
  try {
    for (;;) {
      const v = cleanDbName((await ask(`Nombre de la base de datos [${DEFAULT_DB_NAME}]: `)).trim() || DEFAULT_DB_NAME);
      if (v) return v;
      console.log(`  Nombre no valido. ${DB_NAME_HELP}`);
    }
  } finally { rl.close(); }
}

async function init() {
  if (existsSync(join(DATA, 'PG_VERSION'))) {
    console.log('La base de datos local ya existe.');
    if (!existsSync(ENV_FILE)) fail('Existe la carpeta data\\pg pero falta el archivo .env (con las claves). Restaura el .env de la copia anterior.');
    return;
  }
  if (existsSync(ENV_FILE)) fail('Ya existe un archivo .env pero no hay base de datos local (data\\pg). Borra o mueve el .env para empezar de cero.');

  const dbName = await chooseDbName();
  mkdirSync(dirname(DATA), { recursive: true });
  const adminPass = randomBytes(18).toString('hex');
  const pwfile = join(tmpdir(), `drap-pw-${randomBytes(6).toString('hex')}`);
  writeFileSync(pwfile, adminPass + '\n', { mode: 0o600 });
  console.log('Creando la base de datos local (un momento)...');
  const r = run(bin('initdb'), ['-D', DATA, '-U', 'postgres', '-E', 'UTF8', '--auth=scram-sha-256', `--pwfile=${pwfile}`, '--no-instructions']);
  rmSync(pwfile, { force: true });
  if (r.status !== 0) { rmSync(DATA, { recursive: true, force: true }); fail(`No se pudo crear la base de datos local:\n${r.stdout ?? ''}${r.stderr ?? ''}`); }

  // Solo la propia maquina puede conectarse; puerto propio.
  const conf = [
    '', '# --- DRAP Inventory ---',
    "listen_addresses = '127.0.0.1'",
    `port = ${DEFAULT_PORT}`,
    'max_connections = 100',
    process.platform === 'win32' ? '' : `unix_socket_directories = '${DATA.replace(/'/g, "''")}'`,
    '',
  ].join('\n');
  appendFileSync(join(DATA, 'postgresql.conf'), conf);

  const env = [
    '# Generado por scripts/local-pg.mjs (PostgreSQL incluido en el paquete)',
    'NODE_ENV=production',
    'PORT=3000',
    `JWT_SECRET=${randomBytes(48).toString('hex')}`,
    '# En la PC se usa http (sin certificado). Con HTTPS y dominio cambia a true.',
    'COOKIE_SECURE=false',
    '',
    'DB_HOST=127.0.0.1',
    `DB_PORT=${DEFAULT_PORT}`,
    '# Nombre de la base de datos. Se crea al instalar; si lo cambias despues, se creara una base nueva y vacia.',
    `DB_NAME=${dbName}`,
    'DB_ADMIN_USER=postgres',
    `DB_ADMIN_PASSWORD=${adminPass}`,
    `DB_APP_USER=${appUserFor(dbName)}`,
    `DB_APP_PASSWORD=${randomBytes(18).toString('hex')}`,
    '',
  ].join('\n');
  writeFileSync(ENV_FILE, env, { mode: 0o600 });
  console.log(`Base de datos local creada (nombre: ${dbName}) y archivo .env generado.`);
}

function start() {
  if (!existsSync(join(DATA, 'PG_VERSION'))) fail('Todavia no se ha instalado. Ejecuta primero instalar.bat.');
  if (isRunning()) { console.log('PostgreSQL ya esta encendido.'); return; }
  mkdirSync(dirname(LOG), { recursive: true });
  console.log('Encendiendo PostgreSQL...');
  // La salida de pg_ctl va a un archivo (no a una tuberia): el servidor que queda en segundo plano no debe heredar tuberias
  // de este proceso, o spawnSync esperaria para siempre.
  const out = join(dirname(LOG), 'pg-start.txt');
  const fd = openSync(out, 'w');
  let r;
  try { r = spawnSync(bin('pg_ctl'), ['start', '-D', DATA, '-l', LOG, '-w', '-t', '90', '-o', `-p ${port()}`], { stdio: ['ignore', fd, fd], windowsHide: true }); }
  finally { closeSync(fd); }
  if (r.status !== 0) {
    const tail = existsSync(LOG) ? readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-15).join('\n') : '';
    const said = existsSync(out) ? readFileSync(out, 'utf8') : '';
    fail(`No se pudo encender PostgreSQL.\n${said}\n--- data\\pg.log ---\n${tail}\nSi otro programa usa el puerto ${port()}, cambia DB_PORT en el archivo .env.\nSi Windows habla de un archivo .dll que falta, instala "Microsoft Visual C++ Redistributable x64".`);
  }
  console.log('PostgreSQL listo.');
}

function stop() {
  if (!existsSync(join(DATA, 'PG_VERSION')) || !isRunning()) { console.log('PostgreSQL ya estaba apagado.'); return; }
  const r = run(bin('pg_ctl'), ['stop', '-D', DATA, '-m', 'fast', '-w', '-t', '60']);
  if (r.status !== 0) fail(`No se pudo apagar PostgreSQL:\n${r.stderr ?? ''}`);
  console.log('PostgreSQL apagado.');
}

const cmd = process.argv[2];
if (cmd === 'init') await init();
else if (cmd === 'start') start();
else if (cmd === 'stop') stop();
else if (cmd === 'status') { console.log(isRunning() ? 'encendido' : 'apagado'); process.exit(isRunning() ? 0 : 3); }
else fail('Uso: node scripts/local-pg.mjs init | start | stop | status');
