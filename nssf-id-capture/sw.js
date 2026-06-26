const CACHE_NAME = 'nssf-id-capture-v10';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/parser.js',
  './js/xlsx.full.min.js',
  './js/tesseract.min.js',
  './js/opencv.js',
  './js/worker.min.js',
  './assets/favicon.ico'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  // Stale-While-Revalidate strategy for app resources
  e.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(e.request).then((cachedResponse) => {
        const fetchPromise = fetch(e.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(e.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => cachedResponse); // fallback to cache on network failure

        return cachedResponse || fetchPromise;
      });
    })
  );
});
