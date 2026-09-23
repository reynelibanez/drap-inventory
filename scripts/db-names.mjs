// Nombre de la base de datos (y del usuario de la aplicacion) que se eligen al instalar. Sin dependencias.
// El nombre queda escrito en el archivo .env (DB_NAME y DB_APP_USER): ahi es donde se configura.

export const DEFAULT_DB_NAME = 'drap_inventory';
const RESERVED = new Set(['postgres', 'template0', 'template1']);

/** Devuelve el nombre limpio (minusculas) o null si no sirve. Solo letras, numeros y guion bajo; empieza con letra; hasta 40 caracteres. */
export function cleanDbName(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(v)) return null;
  if (RESERVED.has(v) || v.startsWith('pg_')) return null;
  return v;
}

/** Explicacion para mostrar cuando el nombre no es valido. */
export const DB_NAME_HELP = 'Usa solo letras, numeros y guion bajo (_), empezando con una letra, hasta 40 caracteres. Ejemplo: drap_inventory';

/** Usuario de PostgreSQL con el que trabaja la aplicacion: se deriva del nombre de la base. */
export function appUserFor(dbName) {
  return `${dbName}_app`.slice(0, 60);
}

/** Toma el nombre de --db=NOMBRE o de la variable DRAP_DB_NAME (instalaciones sin preguntas). undefined si no se indico. */
export function dbNameFromArgs(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a.startsWith('--db='));
  const raw = arg ? arg.slice(5) : env.DRAP_DB_NAME;
  if (raw === undefined || raw === '') return undefined;
  const v = cleanDbName(raw);
  if (!v) { console.error(`\n[X] Nombre de base de datos no valido: "${raw}". ${DB_NAME_HELP}\n`); process.exit(1); }
  return v;
}
