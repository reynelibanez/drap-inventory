/**
 * Base de datos del navegador (IndexedDB) para el trabajo sin conexión, sin dependencias.
 * Si el navegador no la permite (ventana privada, bloqueada), todo sigue funcionando en memoria mientras la app esté abierta:
 * en ese caso no se puede guardar trabajo sin conexión de forma duradera (lo avisa `durable()`).
 */

const DB_NAME = 'refurbiz-offline';
const DB_VERSION = 1;
export type StoreName = 'cache' | 'outbox' | 'kv';

let dbPromise: Promise<IDBDatabase | null> | null = null;
let seqMem = 0;
const mem: Record<StoreName, Map<IDBValidKey, any>> = { cache: new Map(), outbox: new Map(), kv: new Map() };
let isDurable = true;

/** ¿Lo guardado sobrevive a cerrar la app? */
export const durable = () => isDurable;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') { isDurable = false; resolve(null); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => { isDurable = false; resolve(null); };
      req.onblocked = () => { isDurable = false; resolve(null); };
    } catch { isDurable = false; resolve(null); }
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  try {
    const t = db.transaction(store, mode);
    const r = await wrap(fn(t.objectStore(store)));
    return r;
  } catch { isDurable = false; return undefined; }
}

export const idb = {
  async get<T = any>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    const db = await open();
    if (!db) return mem[store].get(key);
    return tx<T>(store, 'readonly', (s) => s.get(key));
  },
  async getAll<T = any>(store: StoreName): Promise<T[]> {
    const db = await open();
    if (!db) return [...mem[store].values()];
    return (await tx<T[]>(store, 'readonly', (s) => s.getAll())) ?? [];
  },
  /** Guarda (o reemplaza). En `outbox` sin `seq` asigna el siguiente y lo devuelve. */
  async put<T extends Record<string, any>>(store: StoreName, value: T): Promise<T> {
    const db = await open();
    if (!db) {
      if (store === 'outbox' && value.seq === undefined) (value as any).seq = ++seqMem;
      mem[store].set(store === 'cache' || store === 'kv' ? value.k : value.seq, value);
      return value;
    }
    if (store === 'outbox' && value.seq === undefined) {
      const key = await tx<IDBValidKey>(store, 'readwrite', (s) => s.add(value));
      if (key === undefined) { (value as any).seq = ++seqMem; mem.outbox.set(value.seq, value); return value; }
      (value as any).seq = key as number;
      return value;
    }
    const r = await tx(store, 'readwrite', (s) => s.put(value));
    if (r === undefined) mem[store].set(store === 'outbox' ? value.seq : value.k, value);
    return value;
  },
  async delete(store: StoreName, key: IDBValidKey): Promise<void> {
    const db = await open();
    if (!db) { mem[store].delete(key); return; }
    await tx(store, 'readwrite', (s) => s.delete(key));
  },
  async clear(store: StoreName): Promise<void> {
    const db = await open();
    if (!db) { mem[store].clear(); return; }
    await tx(store, 'readwrite', (s) => s.clear());
  },
};

/** Guarda un valor suelto (sesión sin conexión, contadores, modelos nuevos…). */
export const kv = {
  async get<T = any>(k: string): Promise<T | undefined> { return (await idb.get<{ k: string; v: T }>('kv', k))?.v; },
  async set<T = any>(k: string, v: T): Promise<void> { await idb.put('kv', { k, v }); },
  async del(k: string): Promise<void> { await idb.delete('kv', k); },
};

/** Se le pide al navegador que no borre estos datos cuando le falte espacio. */
export async function requestPersistence(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
}
