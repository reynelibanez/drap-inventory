import { cacheScope } from './cache';
import { kv } from './idb';

/**
 * Valores de lista (p. ej. un modelo nuevo) agregados sin conexión. El servidor los crea al sincronizar; mientras tanto se guardan aquí
 * con su id provisional para que se puedan elegir en los siguientes equipos.
 */
export interface LocalModel { id: number; catalogId: number; parentItemId: number | null; name: string }

let list: LocalModel[] = [];
let loadedScope: string | null = null;
const listeners = new Set<() => void>();

export const localModels = (): LocalModel[] => list;
export function onLocalModels(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

export async function loadLocalModels(): Promise<void> {
  const s = cacheScope();
  if (!s || loadedScope === s) return;
  loadedScope = s;
  list = (await kv.get<LocalModel[]>(`models:${s}`)) ?? [];
  listeners.forEach((l) => l());
}

const norm = (n: string) => n.replace(/\s+/g, ' ').trim().toLowerCase();

/** El valor pendiente igual (mismo catálogo, marca y nombre), si ya se había agregado. */
export const findLocalModel = (catalogId: number, parentItemId: number | null, name: string): LocalModel | undefined =>
  list.find((m) => m.catalogId === catalogId && m.parentItemId === parentItemId && norm(m.name) === norm(name));

export async function addLocalModel(m: LocalModel): Promise<void> {
  const s = cacheScope();
  if (!s) return;
  list = [...list.filter((x) => x.id !== m.id), m];
  await kv.set(`models:${s}`, list);
  listeners.forEach((l) => l());
}

/** Ya sincronizado: el servidor los tiene en su catálogo. */
export async function clearLocalModels(): Promise<void> {
  const s = cacheScope();
  if (!s || !list.length) return;
  list = [];
  await kv.set(`models:${s}`, list);
  listeners.forEach((l) => l());
}
