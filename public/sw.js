// Service Worker des Tippspiels: Ohne Internet erscheint eine Hinweisseite statt einer Fehlerseite des Browsers.
// Sonst läuft alles wie immer über das Netz – es wird nichts zwischengespeichert, was veralten könnte.
'use strict';

const CACHE = 'tippspiel-offline-1';
const OFFLINE = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const res = await fetch(OFFLINE, { cache: 'no-store' });
      const page = await res.clone().text();
      await cache.put(OFFLINE, res);
      // Gestaltung und Schriften der Hinweisseite mitnehmen
      const assets = [...page.matchAll(/(?:href|src)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
      await Promise.all(assets.map((a) => cache.add(a).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE)));
  } else if (new URL(request.url).pathname.startsWith('/static/')) {
    event.respondWith(fetch(request).catch(() => caches.match(request, { ignoreSearch: true })));
  }
});

// Push-Nachrichten (Erinnerung an fehlende Tipps)
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Tippspiel', {
      body: data.body || '',
      icon: '/static/icon-192.png',
      badge: '/static/icon-192.png',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      renotify: typeof data.tag === 'string',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) await c.navigate(url).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
