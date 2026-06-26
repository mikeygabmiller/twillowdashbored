/* Mikey's Detailing dashboard — service worker.
 * Makes the app installable + loads instantly (and offline) by caching the
 * app shell. API calls are always live (never cached). */
const CACHE = 'mkd-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache the backend — texts/threads must always be live.
  if (url.pathname.startsWith('/api/') || url.pathname === '/submit' ||
      url.pathname === '/sms' || url.pathname === '/call' ||
      url.pathname.startsWith('/voicemail')) {
    return;
  }

  // App shell (the page itself): network-first, fall back to cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets (icons, etc.): cache-first.
  e.respondWith(caches.match(req).then((c) => c || fetch(req)));
});
