/** Cliente HTTP: token de acceso en memoria + renovación automática con la cookie de sesión + trabajo sin conexión. */

import { ApiError } from './apiError';
import { cacheGet, cachePut, isCacheable } from './offline/cache';
import { isOnline, reportNetworkError, reportServerReached } from './offline/net';
import { classify, idMapping, outboxReady, substitute, tempRefs, type Method } from './offline/outbox';
import { deriveGet } from './offline/derive';
import { localPost, overlayGet, synthGet } from './offline/overlay';
import { enqueue, mustQueue } from './offline/queue';
import { NetworkError, setTransport } from './offline/sync';

export { ApiError };

let accessToken: string | null = null;
let onExpired: (() => void) | null = null;
let refreshing: Promise<any | null> | null = null;
/** El último intento de renovar la sesión falló por falta de conexión (no porque la sesión haya caducado). */
let refreshOffline = false;
export const refreshFailedOffline = (): boolean => refreshOffline;

/** Se abrió la app sin conexión con una sesión guardada: las consultas salen de la copia local hasta que vuelva el servidor. */
let offlineSession = false;
export const setOfflineSession = (v: boolean) => { offlineSession = v; };
let onRestored: ((s: any) => void) | null = null;
/** La sesión guardada volvió a ser válida con el servidor (llegan permisos actualizados). */
export const setOnSessionRestored = (fn: (s: any) => void) => { onRestored = fn; };

export const setAccessToken = (t: string | null) => { accessToken = t; };
export const getAccessToken = () => accessToken;
export const setOnSessionExpired = (fn: () => void) => { onExpired = fn; };

const GET_TIMEOUT_MS = 20_000;

async function parse(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function request(method: string, path: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  return fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'include', signal });
}

/** Renueva la sesión (una sola petición aunque varias fallen a la vez). */
export function refreshSession(): Promise<any | null> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        refreshOffline = false;
        reportServerReached();
        if (!res.ok) return null;
        const data = await res.json();
        accessToken = data.accessToken;
        return data;
      } catch {
        refreshOffline = true;   // sin red o servidor caído: la sesión puede seguir vigente
        return null;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

/** Una petición al servidor con renovación de sesión. Lanza `NetworkError` si no hay conexión. */
async function send(method: string, path: string, body?: unknown, opts: { signal?: AbortSignal; headers?: Record<string, string>; timeout?: number } = {}): Promise<{ res: Response; data: any }> {
  const once = async () => {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener('abort', onAbort);
    const timer = opts.timeout ? setTimeout(() => ctl.abort(), opts.timeout) : null;
    try { return await request(method, path, body, ctl.signal, opts.headers); }
    catch (e) {
      if (opts.signal?.aborted) throw e;            // lo canceló la pantalla: no es un problema de red
      throw new NetworkError();
    } finally { if (timer) clearTimeout(timer); opts.signal?.removeEventListener('abort', onAbort); }
  };
  let res = await once();
  if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/refresh')) {
    const data = await parse(res.clone());
    if (data?.error?.code === 'company_not_selected') return { res, data };
    const s = await refreshSession();
    if (s) res = await once();
    else if (refreshOffline) throw new NetworkError();
    else return { res, data: { error: { code: 'no_session' } } };
  }
  reportServerReached();
  return { res, data: await parse(res) };
}

// Envío de las acciones guardadas (lo usa la sincronización).
setTransport(async (method, path, body, headers) => {
  const { res, data } = await send(method, path, body, { headers });
  return { status: res.status, data };
});

const fail = (res: Response, data: any) => {
  const e = data?.error;
  return new ApiError(res.status, e?.code ?? 'internal', e?.params ?? {});
};

/**
 * ¿Se puede hablar con el servidor ahora? Si la app abrió sin conexión con una sesión guardada, al volver la red se renueva la
 * sesión primero; si ya caducó, se pide iniciar sesión (lo pendiente se conserva y se envía después).
 */
async function ensureSession(): Promise<boolean> {
  if (!isOnline()) return false;
  if (!offlineSession || accessToken) return true;
  const s = await refreshSession();
  if (s) { offlineSession = false; onRestored?.(s); return true; }
  if (refreshOffline) return false;
  onExpired?.();
  return false;
}

async function fromCache(path: string): Promise<any> {
  const hit = await cacheGet(path);
  if (hit) return overlayGet(path, hit.data);
  // Otra consulta distinta a las guardadas (otro filtro, un equipo suelto…): se calcula con un listado completo ya descargado.
  const derived = await deriveGet(path);
  if (derived === undefined) throw new ApiError(0, 'offline_no_cache');
  return overlayGet(path, derived);
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  await outboxReady();
  const p = substitute(path, idMapping());
  const synth = await synthGet(p);                       // algo que solo existe en la bandeja (lote/equipo aún sin enviar)
  if (synth !== undefined) return synth as T;
  if (!(await ensureSession())) return fromCache(p);
  try {
    const { res, data } = await send('GET', p, undefined, { signal, timeout: GET_TIMEOUT_MS });
    if (res.status === 401 && data?.error?.code === 'no_session') { onExpired?.(); throw new ApiError(401, 'no_session'); }
    if (!res.ok) throw fail(res, data);
    if (isCacheable(p)) cachePut(p, data);
    return (await overlayGet(p, data)) as T;
  } catch (e) {
    if (e instanceof NetworkError) { reportNetworkError(); return fromCache(p); }
    throw e;
  }
}

/** Consultas que van por POST pero no cambian nada: sin conexión (o con trabajo pendiente) se responden con lo que hay en el equipo. */
const READ_POSTS = new Set(['/quick-sales/check', '/locations/suggest']);

async function readPost<T>(path: string, body: unknown, usable: boolean): Promise<T> {
  if (usable && !mustQueue(path, body, true)) {
    try {
      const { res, data } = await send('POST', path, body ?? {});
      if (res.status === 401 && data?.error?.code === 'no_session') { onExpired?.(); throw new ApiError(401, 'no_session'); }
      if (!res.ok) throw fail(res, data);
      return data as T;
    } catch (e) {
      if (!(e instanceof NetworkError)) throw e;
      reportNetworkError();
    }
  }
  const local = await localPost(substitute(path, idMapping()), substitute(body ?? {}, idMapping()) as any);
  if (local === undefined) throw new ApiError(0, 'offline_required');
  return local as T;
}

async function mutate<T>(method: Method, path: string, body: unknown): Promise<T> {
  await outboxReady();
  const kind = classify(method, path);
  const usable = await ensureSession();
  if (!kind && READ_POSTS.has(path.split('?')[0])) return readPost<T>(path, body, usable);
  if (kind && mustQueue(path, body, usable)) return enqueue(method, path, body) as Promise<T>;
  if (!kind && tempRefs(path, body).length) throw new ApiError(0, 'unsynced_reference');
  if (!usable) throw new ApiError(0, 'offline_required');

  // Las acciones que se pueden guardar salen con su llave: si la conexión se corta a la mitad, el reintento no duplica nada.
  const key = kind ? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`) : undefined;
  try {
    const { res, data } = await send(method, path, body ?? {}, { headers: key ? { 'Idempotency-Key': key } : undefined });
    if (res.status === 401 && data?.error?.code === 'no_session') { onExpired?.(); throw new ApiError(401, 'no_session'); }
    if (!res.ok) throw fail(res, data);
    notifyChanged(path);
    return data as T;
  } catch (e) {
    if (e instanceof NetworkError) {
      reportNetworkError();
      if (kind) return enqueue(method, path, body, key) as Promise<T>;
      throw new ApiError(0, 'offline_required');
    }
    throw e;
  }
}

/** Avisa que se guardó algo que puede haber agregado modelos nuevos al catálogo (para que aparezcan en las sugerencias). */
const changed = new Set<() => void>();
export const onServerChange = (fn: () => void) => { changed.add(fn); return () => { changed.delete(fn); }; };
function notifyChanged(path: string) { if (/^\/(units|lots|assets|orders\/quick)/.test(path)) changed.forEach((f) => f()); }

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (method === 'GET') return get<T>(path, signal);
  if (path.startsWith('/auth/')) return plain<T>(method, path, body, signal);
  return mutate<T>(method as Method, path, body);
}

/** Sesión y perfil: siempre directo al servidor (no se guardan para después). */
async function plain<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  try {
    const { res, data } = await send(method, path, body, { signal });
    if (res.status === 401 && data?.error?.code === 'no_session') { onExpired?.(); throw new ApiError(401, 'no_session'); }
    if (!res.ok) throw fail(res, data);
    return data as T;
  } catch (e) {
    if (e instanceof NetworkError) { reportNetworkError(); throw new ApiError(0, 'offline_required'); }
    throw e;
  }
}

export const api = {
  get: <T = any>(path: string, signal?: AbortSignal) => call<T>('GET', path, undefined, signal),
  post: <T = any>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  put: <T = any>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {}),
  patch: <T = any>(path: string, body?: unknown) => call<T>('PATCH', path, body ?? {}),
  del: <T = any>(path: string) => call<T>('DELETE', path),
  /** Descarga un archivo autenticado (PDF) y lo abre en una pestaña nueva. */
  async openFile(path: string): Promise<void> {
    if (!isOnline()) throw new ApiError(0, 'offline_required');
    const w = window.open('', '_blank');
    try {
      const res = await request('GET', path);
      if (res.status === 401) {
        const s = await refreshSession();
        if (!s) throw new ApiError(401, 'no_session');
        return this.openFile(path);
      }
      if (!res.ok) { const d = await parse(res); throw new ApiError(res.status, d?.error?.code ?? 'internal', d?.error?.params); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url; else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      w?.close();
      if (e instanceof TypeError) { reportNetworkError(); throw new ApiError(0, 'offline_required'); }
      throw e;
    }
  },
};

export function qs(params: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}
