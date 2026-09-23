import { useSyncExternalStore } from 'react';
import { isOnline, onReconnect, reportNetworkError, reportServerReached } from './net';
import { forgetScan } from './overlay';
import { learnOrderIds } from './domains/orders';
import { clearLocalModels } from './models';
import {
  dependentsOf, hasActive, idMapping, listOps, outboxReady, recordIds, removeOps, substitute, tempRefs, updateOp, waitingFor, type Op,
} from './outbox';

/**
 * Envío de lo guardado sin conexión. Las acciones salen en el orden en que se hicieron; cada una lleva su llave única, así un
 * reintento nunca duplica nada. Si el servidor rechaza una acción (por ejemplo, número de serie repetido) esa acción queda
 * "con error" para que la persona la corrija o la descarte, y solo se detienen las que dependían de ella.
 */
export class NetworkError extends Error { constructor() { super('network'); } }
export type Transport = (method: string, path: string, body: unknown, headers: Record<string, string>) => Promise<{ status: number; data: any }>;

let transport: Transport | null = null;
export const setTransport = (t: Transport) => { transport = t; };

interface SyncState { syncing: boolean; needsLogin: boolean; lastSyncAt: number | null }
let state: SyncState = { syncing: false, needsLogin: false, lastSyncAt: null };
const listeners = new Set<() => void>();
const set = (p: Partial<SyncState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
export const useSyncState = (): SyncState => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state, () => state);
export const syncState = () => state;

let onDone: ((info: { synced: number; remaining: number }) => void) | null = null;
/** La app se entera de que hubo cambios en el servidor (para recargar las pantallas). */
export const setSyncListener = (fn: (info: { synced: number; remaining: number }) => void) => { onDone = fn; };

let running = false;
let inFlight: number | null = null;
export const inFlightSeq = () => inFlight;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let transientFails = 0;

const clearRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };
function scheduleRetry() {
  clearRetry();
  const wait = Math.min(60_000, 4000 * 2 ** Math.min(transientFails, 4));
  transientFails++;
  retryTimer = setTimeout(() => { retryTimer = null; void kick(); }, wait);
}

/** Pide un envío (no hace nada si ya hay uno en curso, no hay conexión o no hay nada pendiente). */
export async function kick(): Promise<void> {
  await outboxReady();
  if (running || !transport || !isOnline() || !hasActive()) return;
  // Una sola pestaña envía a la vez.
  const locks = (typeof navigator !== 'undefined' ? navigator.locks : undefined) as LockManager | undefined;
  if (locks) await locks.request('refurbiz-sync', { ifAvailable: true }, async (lock) => { if (lock) await run(); });
  else await run();
}

async function run(): Promise<void> {
  if (running) return;
  running = true;
  set({ syncing: true, needsLogin: false });
  let synced = 0;
  let stop: 'net' | 'login' | 'server' | null = null;
  try {
    for (;;) {
      const next = listOps().find((o) => o.state === 'pending' && !waitingFor(o));
      if (!next) break;
      const map = idMapping();
      const path = substitute(next.path, map);
      const body = substitute(next.body, map);
      if (tempRefs(path, body).length) {
        // depende de algo que ya no existe (se descartó): no se puede enviar
        await updateOp(next.seq, { state: 'failed', error: { status: 0, code: 'dependency_missing', params: {} } });
        continue;
      }
      inFlight = next.seq;
      let r: { status: number; data: any };
      try { r = await transport!(next.method, path, body, { 'Idempotency-Key': next.key }); }
      catch { reportNetworkError(); stop = 'net'; inFlight = null; break; }
      inFlight = null;
      reportServerReached();

      if (r.status >= 200 && r.status < 300) {
        await learnIds(next, r.data);
        await removeOps([next.seq]);
        forgetScan();
        synced++; transientFails = 0;
        continue;
      }
      const err = r.data?.error;
      if (r.status === 401) { stop = 'login'; break; }
      if (r.status === 429 || r.status >= 500 || r.status === 408) { await updateOp(next.seq, { attempts: next.attempts + 1 }); stop = 'server'; break; }
      await updateOp(next.seq, { state: 'failed', attempts: next.attempts + 1, error: { status: r.status, code: err?.code ?? 'internal', params: err?.params ?? {} } });
    }
  } finally {
    running = false; inFlight = null;
    set({ syncing: false, needsLogin: stop === 'login', lastSyncAt: synced ? Date.now() : state.lastSyncAt });
  }
  const remaining = listOps().filter((o) => o.state === 'pending').length;
  if (stop === 'server' || (stop === null && remaining > 0 && listOps().some((o) => o.state === 'pending' && !waitingFor(o)))) scheduleRetry();
  if (synced) {
    if (!listOps().length) void clearLocalModels();
    onDone?.({ synced, remaining });
  }
}

async function learnIds(op: Op, resp: any): Promise<void> {
  const pairs: [number, number][] = [];
  const t = op.temp ?? {};
  if (op.kind === 'lot.create') {
    if (t.lot !== undefined && resp?.id) pairs.push([t.lot, resp.id]);
    (t.lines ?? []).forEach((tid, i) => { const real = resp?.lines?.[i]?.id; if (real) pairs.push([tid, real]); });
  } else if (op.kind === 'line.add' || op.kind === 'line.unexpected') {
    if (t.line !== undefined && resp?.id) pairs.push([t.line, resp.id]);
  } else if (op.kind === 'unit.create') {
    if (t.unit !== undefined && resp?.id) pairs.push([t.unit, resp.id]);
  } else if (op.kind === 'catalog.item') {
    if (t.item !== undefined && resp?.id) pairs.push([t.item, resp.id]);
  } else if (op.kind === 'partner.create') {
    if (t.partner !== undefined && resp?.id) pairs.push([t.partner, resp.id]);
  } else if (op.kind === 'asset.create') {
    (t.assets ?? []).forEach((tid, i) => { const real = resp?.items?.[i]?.id; if (real) pairs.push([tid, real]); });
  } else if (op.kind === 'order.create' || op.kind === 'quick.sale' || op.kind === 'order.line_add' || op.kind === 'order.items') {
    // Los renglones y líneas del pedido no vienen todos en la respuesta: se consulta el pedido para relacionarlos.
    const fetchOrder = async (id: number) => {
      try { const r = await transport!('GET', `/orders/${id}`, undefined, {}); return r.status === 200 ? r.data : null; } catch { return null; }
    };
    pairs.push(...await learnOrderIds(op, resp, fetchOrder));
  }
  if (pairs.length) recordIds(pairs);
}

// -------- acciones de la persona sobre una acción con error --------

/** Vuelve a intentar una acción con error (y las que estaban esperando por ella). */
export async function retryOp(seq: number): Promise<void> {
  const op = listOps().find((o) => o.seq === seq);
  if (!op) return;
  await updateOp(seq, { state: 'pending', error: undefined });
  void kick();
}
export async function retryAll(): Promise<void> {
  for (const o of listOps()) if (o.state === 'failed') await updateOp(o.seq, { state: 'pending', error: undefined });
  transientFails = 0;
  void kick();
}

/** Descarta una acción y todo lo que dependía de ella. Devuelve cuántas se quitaron. */
export async function discardOp(seq: number): Promise<number> {
  const op = listOps().find((o) => o.seq === seq);
  if (!op) return 0;
  const gone = [op, ...dependentsOf(op)].filter((o) => o.seq !== inFlight);
  await removeOps(gone.map((o) => o.seq));
  onDone?.({ synced: 0, remaining: listOps().length });
  return gone.length;
}

/** Corrige el número de serie de un equipo que el servidor rechazó (en su registro y en lo que dependía de él). */
export async function editOpSerial(seq: number, serial: string): Promise<void> {
  const op = listOps().find((o) => o.seq === seq);
  if (!op) return;
  const targets = [op, ...dependentsOf(op)];
  for (const o of targets) {
    if (o.body && typeof o.body === 'object' && 'serialNumber' in o.body) await updateOp(o.seq, { body: { ...o.body, serialNumber: serial.trim() || null } });
  }
  await retryOp(seq);
  for (const o of targets) if (o.state === 'failed' && o.seq !== seq) await updateOp(o.seq, { state: 'pending', error: undefined });
}

// -------- disparadores --------
onReconnect(() => { transientFails = 0; void kick(); });
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void kick(); });
  // Red de seguridad: si algo quedó pendiente y no hubo aviso de conexión, se intenta cada minuto.
  setInterval(() => { if (isOnline() && hasActive() && !running) void kick(); }, 60_000);
}
