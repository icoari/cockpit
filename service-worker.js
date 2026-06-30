const CACHE = 'bob-v73';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './modules/icons.js',
  './modules/util.js',
  './modules/state.js',
  './modules/geolocation.js',
  './modules/weatherCard.js',
  './modules/airquality.js',
  './modules/gas.js',
  './modules/trains.js',
  './modules/lastTrain.js',
  './modules/calendar.js',
  './modules/bins.js',
  './modules/pharmacies.js',
  './modules/writer.js',
  './modules/settings.js',
  './modules/crypto.js',
  './modules/sync.js',
  './modules/llm.js',
  './modules/feed.js',
  './modules/insights.js',
  './modules/copilot.js',
  './modules/pro.js',
  './modules/digest.js',
  './modules/notifications.js',
  './modules/trackers.js',
  './modules/home.js',
  './modules/voice.js',
  './modules/memory.js',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache live API responses
  if (url.hostname.includes('open-meteo.com')
   || url.hostname.includes('iledefrance-mobilites.fr')
   || url.hostname.includes('hn.algolia.com')
   || url.hostname.includes('rss2json.com')
   || url.hostname.includes('data.economie.gouv.fr')
   || url.hostname.includes('air-quality-api.open-meteo.com')
   || url.hostname.includes('googleapis.com')
   || url.hostname.includes('accounts.google.com')
   || url.hostname.includes('overpass-api.de')
   || url.hostname.includes('bob.jz7w76ry59.workers.dev')
   || url.hostname.includes('data.iledefrance.fr')
   || url.hostname.includes('youtube.com')
   || url.hostname.includes('ytimg.com')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Navigations may carry query strings (?goto=… deep links) — match the
  // cached shell regardless or offline loads through those URLs fail.
  const matchOpts = req.mode === 'navigate' ? { ignoreSearch: true } : undefined;

  e.respondWith(
    caches.match(req, matchOpts).then(cached => {
      const fetchPromise = fetch(req).then(resp => {
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ---------- Web Push ----------
self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    // Decode the raw bytes as UTF-8 explicitly. On iOS WebKit, event.data.json()
    // / .text() can mis-decode multi-byte UTF-8 (accents → mojibake), so we go
    // through the ArrayBuffer + TextDecoder, which is reliable everywhere.
    try {
      const text = new TextDecoder('utf-8').decode(event.data.arrayBuffer());
      payload = JSON.parse(text);
    } catch {
      try { payload = event.data.json(); } catch { payload = {}; }
    }
  }
  const title = payload.title || 'Bob';
  const opts = {
    body: payload.body || '',
    tag: payload.tag || 'bob',
    icon: './icons/icon-192.png',
    badge: './icons/icon.svg',
    data: { url: payload.url || '/' },
    renotify: payload.renotify === true,
    requireInteraction: payload.requireInteraction === true,
    actions: Array.isArray(payload.actions) ? payload.actions.slice(0, 2) : undefined,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // The app lives under a sub-path (GitHub Pages) — resolve against the SW
  // scope, never the origin root.
  const raw = (event.notification.data && event.notification.data.url) || './';
  const url = new URL(raw.replace(/^\//, './'), self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try {
          await c.focus();
          c.postMessage({ type: 'notification-clicked', url });
          return;
        } catch {}
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
  })());
});
