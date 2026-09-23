import { useSyncExternalStore } from 'react';

/**
 * Estado de la conexión con el servidor. `navigator.onLine` solo dice si hay red en el equipo; aquí además se marca "sin conexión"
 * cuando una petición falla por red o tarda demasiado, y se comprueba con /api/health hasta que el servidor vuelve a responder.
 */
let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
const listeners = new Set<() => void>();
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelay = 3000;
const onBack = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

export function isOnline(): boolean { return online; }

function setOnline(v: boolean) {
  if (online === v) return;
  online = v;
  emit();
  if (v) { probeDelay = 3000; if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; } onBack.forEach((f) => f()); }
  else scheduleProbe(probeDelay);
}

/** Una petición falló por red (no por una respuesta del servidor). */
export function reportNetworkError() { setOnline(false); }
/** Llegó cualquier respuesta del servidor. */
export function reportServerReached() { setOnline(true); }

/** Se ejecuta cada vez que se recupera la conexión (para sincronizar). Devuelve la función para dejar de escuchar. */
export function onReconnect(fn: () => void): () => void { onBack.add(fn); return () => { onBack.delete(fn); }; }

async function probe(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch('/api/health', { cache: 'no-store', signal: ctl.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

function scheduleProbe(ms: number) {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    if (online) return;
    if (await probe()) setOnline(true);
    else { probeDelay = Math.min(probeDelay * 1.5, 20000); scheduleProbe(probeDelay); }
  }, ms);
}

/** Pide comprobar ya (p. ej. el usuario tocó "Reintentar"). */
export async function checkNow(): Promise<boolean> {
  const ok = await probe();
  setOnline(ok);
  return ok;
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => setOnline(false));
  window.addEventListener('online', () => { void checkNow(); });
  // Al volver a la app (pestaña o teléfono), si estaba sin conexión se vuelve a comprobar.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !online) void checkNow(); });
  if (!online) scheduleProbe(1500);
}

export function useOnline(): boolean {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => online, () => true);
}
