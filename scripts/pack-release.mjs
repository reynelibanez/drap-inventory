// Crea una carpeta de PRODUCCION liviana (sin codigo fuente ni herramientas de desarrollo) lista para copiar
// a otra PC o servidor.  Uso:
//   npm run release                    -> compila y crea release/drap-inventory (+ .zip)
//   npm run release -- --with-modules  -> ademas incluye node_modules (el destino no necesita internet)
//   npm run release -- --with-node     -> ademas incluye Node.js portatil para Windows (runtime/node.exe): el destino solo
//                                         necesita PostgreSQL. Usa el node.exe con el que se ejecuta este comando (Windows);
//                                         en otro sistema indica uno:  --node-exe=C:\ruta\node.exe
//   npm run release -- --with-postgres -> ademas incluye PostgreSQL portatil (runtime/pgsql): el destino no necesita instalar
//                                         PostgreSQL. Copia el PostgreSQL instalado en esta PC (Windows) o el de --pg-dir=RUTA
//                                         (carpeta con bin, lib y share).
//   npm run release -- --no-build      -> usa lo que ya esta compilado
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const nodeExeArg = process.argv.slice(2).find((a) => a.startsWith('--node-exe='))?.slice('--node-exe='.length);
const withNode = args.has('--with-node') || !!nodeExeArg;
const pgDirArg = process.argv.slice(2).find((a) => a.startsWith('--pg-dir='))?.slice('--pg-dir='.length);
const withPostgres = args.has('--with-postgres') || !!pgDirArg;
const withModules = args.has('--with-modules') || withNode;   // sin npm en el destino, las dependencias deben venir dentro
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, a, cwd = ROOT) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`\n[X] Fallo: ${cmd} ${a.join(' ')}`); process.exit(r.status ?? 1); }
};

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const serverPkg = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));

if (!args.has('--no-build')) { console.log('== Compilando =='); run(npm, ['run', 'build']); }
for (const need of ['server/dist/index.js', 'web/dist/index.html', 'server/migrations']) {
  if (!existsSync(join(ROOT, need))) { console.error(`[X] Falta ${need}. Ejecuta primero: npm run build`); process.exit(1); }
}

const OUT_BASE = join(ROOT, 'release');
const NAME = 'drap-inventory';
const OUT = join(OUT_BASE, NAME);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const copy = (from, to = from) => cpSync(join(ROOT, from), join(OUT, to), { recursive: true, filter: (s) => !s.endsWith('.map') });
copy('server/dist');
copy('server/migrations');
copy('web/dist');
for (const f of ['setup-env.mjs', 'backup.mjs', 'restore.mjs', 'pg-tools.mjs', 'local-pg.mjs', 'db-names.mjs']) copy(`scripts/${f}`);
copy('.env.example');
if (existsSync(join(ROOT, 'deploy', 'Caddyfile'))) copy('deploy/Caddyfile', 'ejemplos/Caddyfile');

// Node.js portatil (solo Windows): el destino no necesita instalar Node.
if (withNode) {
  const exe = nodeExeArg ? resolve(nodeExeArg) : process.execPath;
  if (!nodeExeArg && process.platform !== 'win32') { console.error('[X] --with-node necesita Windows (usa el node.exe de esta PC). En otro sistema indica uno: --node-exe=RUTA\\node.exe'); process.exit(1); }
  if (!existsSync(exe)) { console.error(`[X] No existe ${exe}`); process.exit(1); }
  const major = Number((nodeExeArg ? '22' : process.versions.node).split('.')[0]);
  if (major < 20) { console.error('[X] Se necesita Node.js 20 o superior para el paquete.'); process.exit(1); }
  mkdirSync(join(OUT, 'runtime'), { recursive: true });
  copyFileSync(exe, join(OUT, 'runtime', 'node.exe'));
  for (const lic of ['LICENSE', 'LICENSE.txt']) { const l = join(dirname(exe), lic); if (existsSync(l)) { copyFileSync(l, join(OUT, 'runtime', 'LICENSE-node.txt')); break; } }
  console.log(`== Node.js incluido (${(statSync(exe).size / 1048576).toFixed(0)} MB) ==`);
}

// PostgreSQL portatil: se copia una instalacion existente (bin, lib, share). PostgreSQL es reubicable: funciona desde cualquier carpeta.
if (withPostgres) {
  const isPgRoot = (d) => ['postgres.exe', 'postgres'].some((n) => existsSync(join(d, 'bin', n)));
  let pgRoot = pgDirArg ? resolve(pgDirArg) : null;
  if (!pgRoot && process.platform === 'win32') {
    const found = [];
    for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const pg = join(base, 'PostgreSQL');
      if (existsSync(pg)) for (const v of readdirSync(pg)) if (/^\d+/.test(v) && isPgRoot(join(pg, v))) found.push([Number(v), join(pg, v)]);
    }
    found.sort((a, b) => b[0] - a[0]);
    pgRoot = found[0]?.[1] ?? null;
  }
  if (!pgRoot || !isPgRoot(pgRoot)) {
    console.error('[X] No encontre una instalacion de PostgreSQL para incluir. Instala PostgreSQL en esta PC o indica la carpeta: --pg-dir="C:\\Program Files\\PostgreSQL\\16"');
    process.exit(1);
  }
  console.log(`== Incluyendo PostgreSQL de ${pgRoot} ==`);
  const skip = (src) => !/\.(pdb|lib|map)$/i.test(src) && !/[\\/]share[\\/](doc|locale)([\\/]|$)/.test(src);
  for (const d of ['bin', 'lib', 'share']) if (existsSync(join(pgRoot, d))) cpSync(join(pgRoot, d), join(OUT, 'runtime', 'pgsql', d), { recursive: true, dereference: true, filter: skip });
  const lic = ['LICENSE', 'COPYRIGHT'].map((n) => join(pgRoot, n)).find(existsSync);
  if (lic) copyFileSync(lic, join(OUT, 'runtime', 'pgsql', 'LICENSE-postgresql.txt'));
}

// package.json de produccion: solo lo necesario para correr (sin workspaces, sin herramientas de desarrollo).
const pkg = {
  name: NAME,
  version: rootPkg.version,
  private: true,
  type: 'module',
  description: rootPkg.description,
  engines: { node: '>=20' },
  scripts: {
    start: 'node server/dist/index.js',
    'db:setup': 'node server/dist/cli/db-setup.js',
    'db:migrate': 'node server/dist/cli/db-migrate.js',
    'create-admin': 'node server/dist/cli/create-admin.js',
    'db:seed-demo': 'node server/dist/cli/seed-demo.js',
    'setup-env': 'node scripts/setup-env.mjs',
    backup: 'node scripts/backup.mjs',
    restore: 'node scripts/restore.mjs',
  },
  dependencies: serverPkg.dependencies,
};
writeFileSync(join(OUT, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(join(OUT, 'release.json'), JSON.stringify({ version: rootPkg.version, built: new Date().toISOString(), withModules, withNode, withPostgres }, null, 2) + '\n');

// Archivo de bloqueo para instalaciones reproducibles (si hay red; si no, se omite y npm resuelve al instalar).
{
  const r = spawnSync(npm, ['install', '--package-lock-only', '--omit=dev', '--no-audit', '--no-fund'], { cwd: OUT, stdio: 'ignore', shell: process.platform === 'win32' });
  if (r.status !== 0) console.log('(No se pudo crear package-lock.json; npm resolvera las versiones al instalar.)');
}
if (withModules) {
  console.log('== Instalando dependencias de produccion dentro del paquete ==');
  run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund'], OUT);
}

// ---------- Archivos de arranque ----------
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const put = (file, text, { windows = false } = {}) => { const p = join(OUT, file); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, windows ? crlf(text) : text.replace(/\r\n/g, '\n')); };

// Usa el Node.js incluido (runtime\\node.exe) si existe; si no, el instalado en el sistema (version 20 o superior).
const NODE_CHECK_BAT = `set "NODE=%~dp0runtime\\node.exe"
if exist "%NODE%" goto :nodeok
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  echo [X] No se encontro Node.js. Instala la version LTS desde https://nodejs.org y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
if %NODEMAJOR% LSS 20 (
  echo [X] Se necesita Node.js 20 o superior. Actualiza desde https://nodejs.org
  pause
  exit /b 1
)
:nodeok
`;

put('instalar.bat', `@echo off
setlocal
cd /d "%~dp0"
title DRAP Inventory - Instalacion
echo.
echo ==============================================
echo   DRAP Inventory - Instalacion (produccion)
echo ==============================================
echo.
${NODE_CHECK_BAT}
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" (
  echo [1/4] Preparando el PostgreSQL incluido en el paquete...
  "%NODE%" scripts\\local-pg.mjs init
  if errorlevel 1 goto :fail
  "%NODE%" scripts\\local-pg.mjs start
  if errorlevel 1 goto :fail
) else (
  echo [1/4] Configurando la conexion a PostgreSQL...
  "%NODE%" scripts\\setup-env.mjs
  if errorlevel 1 goto :fail
)

if exist node_modules\\fastify (
  echo [2/4] Dependencias ya incluidas en el paquete.
) else (
  echo [2/4] Instalando dependencias (necesita internet; puede tardar un poco^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto :fail
)

echo [3/4] Preparando la base de datos...
"%NODE%" server\\dist\\cli\\db-setup.js
if errorlevel 1 goto :fail

echo [4/4] Crear el administrador y la primera empresa
"%NODE%" server\\dist\\cli\\create-admin.js
if errorlevel 1 goto :fail

echo.
echo ----------------------------------------------------------------
echo  DATOS DE PRUEBA (opcional): carga un negocio de ejemplo completo:
echo  un lote con unos 170 equipos variados, otros 4 lotes en distintos
echo  estados, clientes, proveedores, vendedores, costos, precios,
echo  pedidos, ventas rapidas, activos y usuarios de prueba.
echo  Responde S solo para probar; N si vas a usar el sistema de verdad.
echo ----------------------------------------------------------------
set /p DEMO=Cargar datos de prueba? (S/N):
if /i "%DEMO%"=="S" "%NODE%" server\\dist\\cli\\seed-demo.js
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" "%NODE%" scripts\\local-pg.mjs stop

echo.
echo ==============================================
echo   Listo. Para iniciar el sistema usa iniciar.bat
echo ==============================================
pause
exit /b 0

:fail
echo.
echo [X] Algo fallo. Lee el mensaje de arriba y vuelve a ejecutar instalar.bat.
pause
exit /b 1
`, { windows: true });

put('iniciar.bat', `@echo off
cd /d "%~dp0"
title DRAP Inventory
${NODE_CHECK_BAT}
if not exist .env (
  echo Primero ejecuta instalar.bat
  pause
  exit /b 1
)
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" (
  "%NODE%" scripts\\local-pg.mjs start
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Iniciando DRAP Inventory... (cierra esta ventana para detenerlo^)
start "" /min cmd /c "timeout /t 3 >nul & start http://localhost:3000"
"%NODE%" server\\dist\\index.js
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" "%NODE%" scripts\\local-pg.mjs stop
pause
`, { windows: true });

put('actualizar.bat', `@echo off
cd /d "%~dp0"
title DRAP Inventory - Actualizar
${NODE_CHECK_BAT}
echo Use este archivo despues de copiar una version nueva del paquete sobre esta carpeta (el archivo .env se conserva^).
if exist node_modules\\fastify (
  echo Dependencias: se usan las del paquete o las ya instaladas.
) else (
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 goto :fail
)
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" (
  "%NODE%" scripts\\local-pg.mjs start
  if errorlevel 1 goto :fail
)
"%NODE%" server\\dist\\cli\\db-migrate.js
if errorlevel 1 goto :fail
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" "%NODE%" scripts\\local-pg.mjs stop
echo.
echo Listo. Reinicia el sistema con iniciar.bat
pause
exit /b 0
:fail
echo [X] Algo fallo. Revisa el mensaje de arriba.
pause
exit /b 1
`, { windows: true });

put('respaldar.bat', `@echo off
cd /d "%~dp0"
title DRAP Inventory - Copia de seguridad
${NODE_CHECK_BAT}
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" "%NODE%" scripts\\local-pg.mjs start
"%NODE%" scripts\\backup.mjs
echo.
echo La copia queda en la carpeta "backups". Guardala tambien fuera de esta maquina.
pause
`, { windows: true });

put('restaurar.bat', `@echo off
cd /d "%~dp0"
title DRAP Inventory - Restaurar copia
${NODE_CHECK_BAT}
if "%~1"=="" (
  echo Arrastra el archivo de la copia ^(.dump^) y sueltalo sobre restaurar.bat.
  pause
  exit /b 1
)
echo ATENCION: esto reemplaza los datos actuales por los de la copia.
set /p OK=Escribe S para continuar: 
if /i not "%OK%"=="S" exit /b 0
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" "%NODE%" scripts\\local-pg.mjs start
"%NODE%" scripts\\restore.mjs "%~1"
pause
`, { windows: true });

put('detener.bat', `@echo off
cd /d "%~dp0"
title DRAP Inventory - Detener
${NODE_CHECK_BAT}
if exist "%~dp0runtime\\pgsql\\bin\\pg_ctl.exe" (
  "%NODE%" scripts\\local-pg.mjs stop
) else (
  echo Este paquete no incluye PostgreSQL propio: no hay nada que detener.
)
pause
`, { windows: true });

put('instalar.sh', `#!/usr/bin/env bash
# Instalacion en Linux/macOS:  bash instalar.sh
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "[X] Falta Node.js 20 o superior (https://nodejs.org)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "[X] Se necesita Node.js 20 o superior"; exit 1; }
if [ -x runtime/pgsql/bin/pg_ctl ]; then
  echo "[1/4] Preparando el PostgreSQL incluido en el paquete..."
  node scripts/local-pg.mjs init
  node scripts/local-pg.mjs start
  trap 'node scripts/local-pg.mjs stop' EXIT
else
  echo "[1/4] Configurando la conexion a PostgreSQL..."
  node scripts/setup-env.mjs
fi
if [ -d node_modules/fastify ]; then echo "[2/4] Dependencias ya incluidas en el paquete."; else
  echo "[2/4] Instalando dependencias (necesita internet)..."; npm install --omit=dev --no-audit --no-fund; fi
echo "[3/4] Preparando la base de datos..."
npm run db:setup
echo "[4/4] Crear el administrador y la primera empresa"
npm run create-admin
echo "Datos de prueba (opcional): un lote con ~170 equipos variados, 4 lotes mas, clientes, pedidos, ventas, activos y usuarios de prueba."
read -r -p "Cargar datos de prueba? (s/N): " DEMO
case "$DEMO" in s|S) npm run db:seed-demo;; esac
echo; echo "Listo. Inicia con:  bash iniciar.sh   (o instala el servicio: ver LEEME-PRODUCCION.md)"
`);

put('iniciar.sh', `#!/usr/bin/env bash
cd "$(dirname "$0")"
[ -f .env ] || { echo "Primero ejecuta: bash instalar.sh"; exit 1; }
if [ -x runtime/pgsql/bin/pg_ctl ]; then
  node scripts/local-pg.mjs start || exit 1
  trap 'node scripts/local-pg.mjs stop' EXIT
  npm start
else
  exec npm start
fi
`);

put('actualizar.sh', `#!/usr/bin/env bash
# Despues de copiar una version nueva del paquete sobre esta carpeta (el .env se conserva):  bash actualizar.sh
set -e
cd "$(dirname "$0")"
[ -d node_modules/fastify ] || npm install --omit=dev --no-audit --no-fund
if [ -x runtime/pgsql/bin/pg_ctl ]; then node scripts/local-pg.mjs start; trap 'node scripts/local-pg.mjs stop' EXIT; fi
npm run db:migrate
echo "Listo. Reinicia el servicio (por ejemplo: sudo systemctl restart refurbiz)"
`);

put('ejemplos/refurbiz.service', `# Servicio de Linux (systemd). Copiar a /etc/systemd/system/refurbiz.service, ajustar RUTA y USUARIO, y ejecutar:
#   sudo systemctl daemon-reload && sudo systemctl enable --now refurbiz
[Unit]
Description=DRAP Inventory
After=network.target postgresql.service

[Service]
Type=simple
User=USUARIO
WorkingDirectory=/RUTA/drap-inventory
ExecStart=/usr/bin/env node server/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`);

put('LEEME-PRODUCCION.md', `# DRAP Inventory — paquete de producción (v${rootPkg.version})

Este paquete trae **solo lo necesario para correr** el sistema (ya compilado). No incluye el código fuente ni herramientas de desarrollo.

## Requisitos en la máquina destino
${withNode ? '- **Node.js: no hace falta instalarlo** (viene incluido en la carpeta `runtime`; solo para Windows).' : '- **Node.js 20 o superior** (https://nodejs.org).'}
${withPostgres ? '- **PostgreSQL: no hace falta instalarlo** (viene incluido en `runtime\\pgsql`; crea una base propia en `data\\pg`, puerto 5433, accesible solo desde esta máquina). Si Windows dice que falta `VCRUNTIME140.dll` o `MSVCP140.dll`, instala una sola vez «Microsoft Visual C++ Redistributable x64» (gratis, en microsoft.com).' : '- **PostgreSQL 13 o superior**, en esa misma máquina **o en otra** (el instalador te pregunta el servidor).'}
- ${withModules ? 'Este paquete ya trae las dependencias: **no necesita internet**.' : 'Internet solo la primera vez para `npm install`.'}

## Instalar (una sola vez)
- **Windows**: doble clic en \`instalar.bat\`.  **Linux/macOS**: \`bash instalar.sh\`.
${withPostgres ? '- Crea la base de datos local, el administrador y la primera empresa. Solo te pregunta el **nombre de la base de datos** (presiona Enter para usar `drap_inventory`); no te pide datos de PostgreSQL. El nombre queda guardado en el archivo `.env` (`DB_NAME`).' : '- Te pide los datos de PostgreSQL y el **nombre de la base de datos** (Enter = `drap_inventory`), crea la base, el administrador y la primera empresa. El nombre queda en el archivo `.env` (`DB_NAME`).'}

## Iniciar
- **Windows**: \`iniciar.bat\`  ·  **Linux**: \`bash iniciar.sh\` (o como servicio, abajo).
- Se abre en \`http://localhost:3000\` (o el puerto que elegiste). Desde otros equipos: \`http://IP-DE-LA-MAQUINA:3000\`.

## Actualizar a una versión nueva
1. Genera el paquete nuevo y **copia su contenido encima** de esta carpeta (el archivo \`.env\` y tu base de datos no se tocan).
2. Ejecuta \`actualizar.bat\` (o \`bash actualizar.sh\`) y reinicia. Los cambios de base de datos se aplican solos.

## En un servidor Linux (recomendado)
- Servicio que arranca solo: \`ejemplos/refurbiz.service\` (instrucciones dentro del archivo).
- **HTTPS**: pon un proxy delante (Caddy: \`ejemplos/Caddyfile\`, o nginx) y en \`.env\` deja \`COOKIE_SECURE=true\`. **El modo instalable (PWA), las notificaciones y el modo sin conexión en el teléfono necesitan HTTPS** (o \`localhost\`); por \`http://IP\` no funcionan.
- Abre el puerto del sistema (o solo 80/443 si usas proxy) en el firewall.

${withPostgres ? '## Base de datos incluida\n`iniciar.bat` enciende PostgreSQL junto con el sistema y lo apaga al cerrar la ventana (`detener.bat` lo apaga si quedó encendido). Los datos viven en la carpeta `data\\pg`: **no la borres**. Al actualizar, copia el paquete nuevo encima sin tocar `data` ni `.env`.\n' : ''}
## Copias de seguridad
**Windows**: \`respaldar.bat\` crea la copia en la carpeta \`backups\`; para restaurar, arrastra el \`.dump\` sobre \`restaurar.bat\`. \`npm run backup\` crea un archivo con toda la base de datos; \`npm run restore -- archivo.dump\` la restaura (necesita \`pg_dump\`/\`psql\` de PostgreSQL). Guarda las copias fuera de la máquina.

## Archivos
\`server/\` API compilada y migraciones · \`web/\` pantallas compiladas · \`scripts/\` utilidades · \`.env\` (se crea al instalar; **no lo compartas**, tiene las claves) · \`release.json\` versión y fecha del paquete.
`);

// ---------- Zip ----------
let zipPath = null;
const suffix = withPostgres ? '-todo-incluido' : withNode ? '-con-node' : withModules ? '-con-dependencias' : '';
const zipTarget = join(OUT_BASE, `${NAME}-${rootPkg.version}${suffix}.zip`);
rmSync(zipTarget, { force: true });
if (withPostgres && process.platform === 'win32') {
  // Paquete grande: tar.exe (incluido en Windows 10/11) lo comprime sin cargarlo entero en memoria.
  const r = spawnSync('tar.exe', ['-a', '-c', '-f', zipTarget, '-C', OUT_BASE, NAME], { stdio: 'inherit' });
  if (r.status === 0 && existsSync(zipTarget)) zipPath = zipTarget;
  else rmSync(zipTarget, { force: true });
}
if (!zipPath) {
  try {
    const { zipSync } = await import('fflate');
    const files = {};
    const walk = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else files[`${NAME}/${relative(OUT, p).split(sep).join('/')}`] = new Uint8Array(readFileSync(p));
      }
    };
    walk(OUT);
    writeFileSync(zipTarget, zipSync(files, { level: 6 }));
    zipPath = zipTarget;
  } catch (e) {
    console.log('(No se creo el .zip: ' + (e?.message ?? e) + '. La carpeta esta lista para copiar.)');
  }
}

console.log(`\nPaquete de produccion listo:\n  Carpeta: ${OUT}${zipPath ? `\n  Zip:     ${zipPath} (${(statSync(zipPath).size / 1048576).toFixed(1)} MB)` : ''}\n`);
console.log('Copia el zip (o la carpeta) a la otra maquina, descomprimelo y ejecuta instalar.bat (Windows) o bash instalar.sh (Linux).');
