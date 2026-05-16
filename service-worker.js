const CACHE = 'cockpit-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './modules/icons.js',
  './modules/util.js',
  './modules/state.js',
  './modules/weather.js',
  './modules/trains.js',
  './modules/aiwatch.js',
  './modules/capture.js',
  './modules/todos.js',
  './modules/habits.js',
  './modules/links.js',
  './modules/settings.js',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
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

  // Never cache live API calls
  if (url.hostname.includes('open-meteo.com')
   || url.hostname.includes('iledefrance-mobilites.fr')
   || url.hostname.includes('hn.algolia.com')
   || url.hostname.includes('rss2json.com')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Cache-first for our own assets, fall back to network
  e.respondWith(
    caches.match(req).then(cached => {
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
