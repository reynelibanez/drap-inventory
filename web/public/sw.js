/*
 * DRAP Inventory — service worker.
 *  1) PWA: guarda la "cáscara" de la app para abrirla al instante y mostrar una pantalla amable sin conexión.
 *     Los datos (/api) NUNCA se guardan: siempre vienen del servidor.
 *  2) Push: muestra los avisos aunque la app esté cerrada y abre la pantalla correcta al tocarlos.
 * El marcador de versión (BUILD) lo reemplaza el build: cada versión nueva cambia este archivo y el navegador la detecta sola.
 */
const BUILD = '__BUILD_ID__';
const CACHE = 'refurbiz-' + BUILD;

const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DRAP Inventory</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;background:#eef3f7;color:#0d2438;text-align:center;padding:24px}
.c{max-width:360px}.i{display:block;height:64px;width:auto;margin:0 auto 18px}
button{margin-top:18px;background:#1277B0;color:#fff;border:0;border-radius:8px;padding:10px 18px;font:600 15px system-ui;cursor:pointer}p{color:#4b5563;line-height:1.5}</style></head>
<body><div class="c"><img class="i" alt="DRAP" src="data:image/png;base64,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"><h1 style="font-size:20px">Sin conexión</h1>
<p>No hay conexión con el servidor. Revisa tu internet o la red de la empresa y vuelve a intentar.<br><small>No internet connection. Check your network and try again.</small></p>
<button onclick="location.reload()">Reintentar / Retry</button></div></body></html>`;

self.addEventListener('install', (event) => {
  // Deja lista la pantalla principal para poder abrir sin conexión.
  event.waitUntil(caches.open(CACHE).then((c) => c.add(new Request('/', { cache: 'reload' }))).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Borra las cachés de versiones anteriores.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('refurbiz-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function shell(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    // Cualquier ruta de la app devuelve la misma pantalla principal; se guarda para abrir sin conexión.
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) cache.put('/', res.clone());
    return res;
  } catch {
    return (await cache.match('/')) || new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  const net = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;                 // datos: siempre en vivo
  if (req.mode === 'navigate') { event.respondWith(shell(req)); return; }
  if (url.pathname.startsWith('/assets/')) { event.respondWith(cacheFirst(req)); return; }   // archivos con hash: no cambian nunca
  if (/\.(png|svg|ico|webmanifest|woff2?)$/.test(url.pathname)) event.respondWith(staleWhileRevalidate(req));
});

// ------------------------------------------------------------------ Push
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    await self.registration.showNotification(data.title || 'DRAP Inventory', {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: data.tag || undefined,
      data: { url: data.url || '/', id: data.id || null, event: data.event || null },
    });
    // Si la app está abierta, que actualice la campana al instante.
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'push', event: data.event || null, id: data.id || null }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  const path = target.pathname + target.search;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ type: 'navigate', url: path });   // la app navega sin recargar
        return;
      }
    }
    await self.clients.openWindow(path);
  })());
});
