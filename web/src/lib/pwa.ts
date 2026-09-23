import { useSyncExternalStore } from 'react';

/**
 * PWA: registro del service worker, instalación en el teléfono / PC, aviso de versión nueva y estado de conexión.
 * Un pequeño "store" externo mantiene el estado para que cualquier pantalla lo lea con `usePwa()`.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaState {
  /** El navegador permite instalar la app ahora mismo (Chrome, Edge, Android). */
  canInstall: boolean;
  /** Ya corre como app instalada (ventana propia, sin barra del navegador). */
  installed: boolean;
  /** iPhone/iPad: no hay botón de instalar; se hace desde "Compartir → Añadir a pantalla de inicio". */
  ios: boolean;
  /** Hay una versión nueva descargada esperando. */
  updateReady: boolean;
  online: boolean;
}

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

let state: PwaState = { canInstall: false, installed: isStandalone(), ios: isIos(), updateReady: false, online: navigator.onLine };
const listeners = new Set<() => void>();
const set = (patch: Partial<PwaState>) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };

let deferred: BeforeInstallPromptEvent | null = null;
let registration: ServiceWorkerRegistration | null = null;
let applying = false;

// Estos eventos pueden llegar antes de que se dibuje la primera pantalla: se escuchan desde ya.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as BeforeInstallPromptEvent; set({ canInstall: true }); });
window.addEventListener('appinstalled', () => { deferred = null; set({ canInstall: false, installed: true }); });
window.addEventListener('online', () => set({ online: true }));
window.addEventListener('offline', () => set({ online: false }));
window.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', () => set({ installed: isStandalone() }));

/** Registra el service worker (solo en la versión publicada; en desarrollo estorbaría). */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) set({ updateReady: true });
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) set({ updateReady: true });
        });
      });
      // Busca versiones nuevas al volver a la app y cada hora.
      const check = () => { void reg.update().catch(() => undefined); };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 60 * 60 * 1000);
    }).catch(() => undefined);
  });
  // Al activarse la versión nueva, se recarga una sola vez (y solo si la persona pidió actualizar).
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying) window.location.reload(); });
}

/** Activa la versión nueva (recarga la página). */
export function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting) { window.location.reload(); return; }
  applying = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/** Muestra el cuadro de instalación del navegador. Devuelve true si la persona aceptó. */
export async function installApp(): Promise<boolean> {
  if (!deferred) return false;
  const ev = deferred;
  deferred = null;
  set({ canInstall: false });
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  return outcome === 'accepted';
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const usePwa = (): PwaState => useSyncExternalStore(subscribe, () => state);

/** Avisos del service worker a la app abierta (llegó un push / se tocó una notificación). */
export function onServiceWorkerMessage(fn: (msg: { type: 'push' | 'navigate'; url?: string; event?: string | null }) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined;
  const h = (e: MessageEvent) => { if (e.data && (e.data.type === 'push' || e.data.type === 'navigate')) fn(e.data); };
  navigator.serviceWorker.addEventListener('message', h);
  return () => navigator.serviceWorker.removeEventListener('message', h);
}
