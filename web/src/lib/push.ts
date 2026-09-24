import { api } from './api';

/** Notificaciones push del navegador (Web Push). Solo funcionan con la app publicada (HTTPS o localhost). */

const FLAG = 'push:on';   // el usuario quiere push en este dispositivo (para recuperarlo si el navegador lo pierde)

export const pushSupported = (): boolean =>
  import.meta.env.PROD && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export const pushPermission = (): NotificationPermission | 'unsupported' => (pushSupported() ? Notification.permission : 'unsupported');

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * `navigator.serviceWorker.ready` solo se resuelve cuando hay un service worker ACTIVO para esta página: si el
 * registro nunca llegó a completarse (por ejemplo, la primera vez que se entra por HTTPS con un certificado
 * propio, antes de que el navegador termine de confiar en él) esa promesa queda esperando para siempre, sin
 * fallar. Un tope de tiempo evita que un service worker que nunca arranca deje algo sin efecto para siempre.
 * `timeoutMs` es más corto para usos "de paso" (como cerrar sesión, donde lo importante es no trabar el flujo)
 * y más largo para "Activar notificaciones", donde sí vale la pena esperar a que el service worker recién
 * instalado (que primero debe descargar y guardar en caché toda la aplicación) termine de arrancar.
 */
async function registration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

/** Suscripción de ESTE navegador (o null si no está activada, o si el service worker no respondió a tiempo). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function register(sub: PushSubscription): Promise<void> {
  await api.post('/push/subscribe', { ...sub.toJSON(), userAgent: navigator.userAgent.slice(0, 300) });
}

export type EnableResult = 'ok' | 'denied' | 'unsupported' | 'not_ready';

/** Pide permiso, suscribe este navegador y lo registra en el servidor. */
export async function enablePush(): Promise<EnableResult> {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const { publicKey } = await api.get<{ publicKey: string }>('/push/config');
  // Aquí sí vale la pena esperar más: es la primera vez que este navegador prepara todo lo necesario para
  // recibir avisos, y eso puede tardar unos segundos (sobre todo justo después de instalar o actualizar la app).
  const reg = await registration(15000);
  if (!reg) return 'not_ready';   // el service worker no llegó a activarse a tiempo: puede funcionar si se reintenta
  let sub = await reg.pushManager.getSubscription();
  // Si el servidor cambió de claves, la suscripción vieja ya no sirve.
  const same = sub?.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() === keyBytes(publicKey).join();
  if (sub && !same) { await sub.unsubscribe(); sub = null; }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await register(sub);
  try { localStorage.setItem(FLAG, '1'); } catch { /* sin almacenamiento */ }
  return 'ok';
}

/** Apaga el push en este navegador (y lo quita del servidor). */
export async function disablePush(): Promise<void> {
  try { localStorage.removeItem(FLAG); } catch { /* sin almacenamiento */ }
  const sub = await currentSubscription();
  if (!sub) return;
  try { await api.post('/push/unsubscribe', { endpoint: sub.endpoint }); } catch { /* el servidor lo limpiará solo */ }
  await sub.unsubscribe();
}

/**
 * Al iniciar sesión: deja el dispositivo registrado a nombre de quien entró (varias personas pueden usar un mismo navegador)
 * y lo recupera si el navegador lo perdió. No pide permiso: solo actúa si ya se había activado.
 */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  let wanted = false;
  try { wanted = localStorage.getItem(FLAG) === '1'; } catch { /* sin almacenamiento */ }
  const sub = await currentSubscription();
  if (sub) { await register(sub); return; }
  if (wanted) await enablePush();
}

/** Antes de cerrar sesión: este navegador deja de recibir los avisos de esa persona. */
export async function detachPushDevice(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const sub = await currentSubscription();
    if (sub) await api.post('/push/unsubscribe', { endpoint: sub.endpoint });
  } catch { /* sin red o sin sesión: nada que hacer */ }
}
