const CACHE = 'bob-v12';
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
  './modules/weather.js',
  './modules/weatherCard.js',
  './modules/airquality.js',
  './modules/gas.js',
  './modules/trains.js',
  './modules/lastTrain.js',
  './modules/aiwatch.js',
  './modules/calendar.js',
  './modules/bins.js',
  './modules/pharmacies.js',
  './modules/youtube.js',
  './modules/hackernews.js',
  './modules/settings.js',
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
   || url.hostname.includes('corsproxy.io')
   || url.hostname.includes('data.iledefrance.fr')
   || url.hostname.includes('youtube.com')
   || url.hostname.includes('ytimg.com')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

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
