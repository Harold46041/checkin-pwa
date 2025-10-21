
const CACHE_NAME = 'checkin-cache-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon-180.png'
];
self.addEventListener('install', (event) => { self.skipWaiting(); event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))); });
self.addEventListener('activate', (event) => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE_NAME ? caches.delete(k) : null))).then(()=> self.clients.claim())); });
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode === 'navigate') { event.respondWith(caches.match('index.html').then(c => c || fetch(req))); return; }
  event.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(req, copy)); return res; }).catch(()=> cached)));
});
