import { ApiError } from '../apiError';
import { loadCachedMeta } from './cache';
import { addLocalModel, findLocalModel } from './models';
import { prepare, respondDone, respondTo, validateOp } from './overlay';
import {
  addOp, classify, creatorOf, dependentsOf, isTemp, listOps, newKey, newTempId, outboxReady, pathIds, removeOps, tempNumber, tempRefs, type Method, type Op,
} from './outbox';
import { isOnline } from './net';
import { inFlightSeq, kick } from './sync';

const queuedListeners = new Set<(offline: boolean) => void>();
/** Se llama cada vez que una acción se guarda en la bandeja (para avisar "guardado sin conexión"). */
export const onQueued = (fn: (offline: boolean) => void) => { queuedListeners.add(fn); return () => { queuedListeners.delete(fn); }; };

/**
 * Guarda una acción para enviarla después y devuelve, al instante, una respuesta con la misma forma que daría el servidor
 * (con ids y códigos provisionales), de modo que la pantalla siga su flujo normal.
 */
export async function enqueue(method: Method, path: string, body: unknown, key = newKey()): Promise<any> {
  await outboxReady();
  await loadCachedMeta();
  const kind = classify(method, path);
  if (!kind) throw new ApiError(0, 'offline_required');

  // Equipo o lote creado sin conexión y eliminado antes de enviarlo: no hace falta mandar nada.
  if (kind === 'unit.delete' || kind === 'lot.delete') {
    const id = pathIds(path)[0];
    const creator = isTemp(id) ? creatorOf(id) : undefined;
    if (creator && creator.seq !== inFlightSeq() && creator.kind === (kind === 'unit.delete' ? 'unit.create' : 'lot.create')) {
      await validateOp(kind, path, body);
      const gone = [creator, ...dependentsOf(creator)];
      if (!gone.some((o) => o.seq === inFlightSeq())) { await removeOps(gone.map((o) => o.seq)); return { ok: true }; }
    }
  }

  // Un valor de lista nuevo (p. ej. un modelo bajo su marca): si ya existe se usa ese; si no, queda pendiente con id provisional.
  if (kind === 'catalog.item') {
    const found = await existingCatalogItem(pathIds(path)[0], body as any);
    if (found) return { id: found, existed: true };
  }

  // Los pedidos escogen aquí los equipos (con las reglas del servidor) y se guardan ya resueltos.
  const prepared = await prepare(kind, path, body as any);
  if (prepared?.done) return respondDone(prepared, path);
  const q = prepared ?? { kind, path, body, temp: undefined };
  await validateOp(q.kind, q.path, q.body as any);

  const temp: NonNullable<Op['temp']> = { ...(q.temp ?? {}) };
  if (kind === 'lot.create') {
    temp.lot = newTempId(); temp.code = `PEND-${tempNumber(temp.lot)}`;
    temp.lines = ((body as any)?.lines ?? []).map(() => newTempId());
  } else if (kind === 'line.add' || kind === 'line.unexpected') temp.line = newTempId();
  else if (kind === 'unit.create') { temp.unit = newTempId(); temp.code = `PEND-${tempNumber(temp.unit)}`; }
  else if (kind === 'catalog.item') temp.item = newTempId();
  else if (kind === 'partner.create') temp.partner = newTempId();
  else if (kind === 'asset.create') {
    const qty = Math.max(1, Math.min(500, Number((body as any)?.quantity ?? 1) || 1));
    temp.assets = Array.from({ length: qty }, () => newTempId());
    temp.codes = temp.assets.map((id) => `PEND-${tempNumber(id)}`);
  }

  const op = await addOp({
    key, kind: q.kind, method, path: q.path, body: q.body === undefined ? undefined : JSON.parse(JSON.stringify(q.body)),
    temp: Object.keys(temp).length ? temp : undefined,
  });

  if (kind === 'catalog.item') {
    const b = (body ?? {}) as any;
    await addLocalModel({ id: temp.item!, catalogId: pathIds(path)[0], parentItemId: b.parentItemId ?? null, name: String(b.name ?? '').replace(/\s+/g, ' ').trim() });
  }

  queuedListeners.forEach((f) => f(!isOnline()));
  void kick();
  try { return await respondTo(op, prepared ?? undefined); } catch { return { ok: true, pendingSync: true }; }
}

/** Id de un valor que ya existe (en el catálogo o pendiente en la bandeja) con el mismo nombre bajo la misma marca. */
async function existingCatalogItem(catalogId: number, body: { name?: string; parentItemId?: number | null }): Promise<number | undefined> {
  const name = String(body?.name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const parent = body?.parentItemId ?? null;
  if (!name) return undefined;
  const meta = await loadCachedMeta();
  const cat = meta?.catalogs?.find((c: any) => c.id === catalogId);
  const hit = cat?.items?.find((i: any) => (i.parentItemId ?? null) === parent && [i.name?.es, i.name?.en].some((n: string) => n?.trim().toLowerCase() === name));
  return hit?.id ?? findLocalModel(catalogId, parent, name)?.id;
}

/** ¿Esta petición debe ir a la bandeja en vez de al servidor? */
export function mustQueue(path: string, body: unknown, online: boolean): boolean {
  return !online || listOps().some((o) => o.state === 'pending') || tempRefs(path, body).length > 0;
}
