/* Mikey's Detailing dashboard — service worker.
 * Makes the app installable + loads instantly (and offline) by caching the
 * app shell. API calls are always live (never cached). Also receives Web Push
 * so new texts, missed calls and the morning brief ring the phone instantly
 * instead of waiting for the next poll. */
const CACHE = 'mkd-shell-v15';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png'];

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

/* ---- Web Push -------------------------------------------------------------
 * The Worker sends pushes WITHOUT a payload (no message content ever crosses
 * the push service), so this handler asks the backend what to say. If that
 * fetch fails — offline, or the session expired — we still show a generic
 * notification, because a push that shows nothing is a spec violation on most
 * browsers and gets the subscription throttled. */
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let d = { title: "Mikey's Dashboard", body: 'New activity — tap to open.', url: '/' };
    try {
      if (e.data) {
        const j = e.data.json();
        if (j && j.title) d = { title: j.title, body: j.body || d.body, url: j.url || '/' };
      }
    } catch (_) { /* payloadless push is the normal path */ }
    try {
      const r = await fetch('/api/push/peek', { credentials: 'include', cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.title) d = { title: j.title, body: j.body || d.body, url: j.url || '/' };
      }
    } catch (_) { /* keep the fallback headline */ }
    await self.registration.showNotification(d.title, {
      body: d.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'mkd-activity',
      renotify: true,
      data: { url: d.url },
    });
  })());
});

/* Tapping the notification focuses the already-open dashboard when there is
 * one (so the PWA doesn't stack windows), otherwise opens it. */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        if ('navigate' in c && target !== '/') { try { await c.navigate(target); } catch (_) {} }
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
