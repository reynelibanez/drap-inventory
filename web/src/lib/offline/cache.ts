import { idb } from './idb';

/**
 * Copia local de las últimas respuestas (GET) del servidor, separada por usuario y empresa.
 * Es lo que se muestra cuando no hay conexión.
 */
interface Entry { k: string; scope: string; path: string; at: number; data: any }

let scope: string | null = null;
let metaSnap: any = null;
const MAX_ENTRIES = 1500;
const MAX_AGE = 90 * 24 * 3600 * 1000;
const MAX_BYTES = 25_000_000;

/** Sube cada vez que cambia algo de la copia local (para no repetir lecturas costosas). */
let version = 0;
export const cacheVersion = () => version;

export const cacheScope = () => scope;
export function setCacheScope(s: string | null) { scope = s; metaSnap = null; }
const key = (path: string) => `${scope}|${path}`;

/** Rutas que no se guardan: sesión, avisos en tiempo real, y todo lo que no sea información de trabajo. */
export function isCacheable(path: string): boolean {
  return !/^\/(auth|push|notifications\/(unread|stream))/.test(path);
}

export async function cacheGet(path: string): Promise<{ data: any; at: number } | undefined> {
  if (!scope) return undefined;
  const e = await idb.get<Entry>('cache', key(path));
  return e ? { data: e.data, at: e.at } : undefined;
}

export function cachePut(path: string, data: any): void {
  if (!scope || !isCacheable(path)) return;
  if (path === '/meta') metaSnap = data;
  let size = 0;
  try { size = JSON.stringify(data).length; } catch { return; }
  if (size > MAX_BYTES) return;
  version++;
  void idb.put('cache', { k: key(path), scope, path, at: Date.now(), data } satisfies Entry).then(() => { version++; });
}

export function cachedMetaSync(): any { return metaSnap; }
export async function loadCachedMeta(): Promise<any> {
  if (!metaSnap) metaSnap = (await cacheGet('/meta'))?.data ?? null;
  return metaSnap;
}

/** Todas las entradas de la copia local de este usuario cuya ruta empieza con `prefix`. */
export async function cacheEntries(prefix: string): Promise<{ path: string; data: any; at: number }[]> {
  if (!scope) return [];
  const all = await idb.getAll<Entry>('cache');
  return all.filter((e) => e.scope === scope && e.path.startsWith(prefix)).map((e) => ({ path: e.path, data: e.data, at: e.at }));
}

/** Reemplaza el contenido de una entrada ya guardada (por ejemplo tras sincronizar). */
export async function cacheDelete(path: string): Promise<void> { if (scope) { await idb.delete('cache', key(path)); version++; } }

/** Limpieza: quita lo muy viejo y limita la cantidad de entradas. */
export async function cachePrune(): Promise<void> {
  const all = await idb.getAll<Entry>('cache');
  const now = Date.now();
  const old = all.filter((e) => now - e.at > MAX_AGE);
  for (const e of old) await idb.delete('cache', e.k);
  const rest = all.filter((e) => now - e.at <= MAX_AGE).sort((a, b) => b.at - a.at);
  for (const e of rest.slice(MAX_ENTRIES)) await idb.delete('cache', e.k);
}

/** Borra la copia local de un usuario/empresa (al salir de la sesión por completo). */
export async function cacheClearAll(): Promise<void> { await idb.clear('cache'); metaSnap = null; version++; }
