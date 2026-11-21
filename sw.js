// Offline support: answer from the saved copy at once (the shop may have no signal)
// and refresh that copy in the background.
// Change the version on every release: a new version then installs as one complete set of files.
const CACHE = 'ah-saldo-v3';
const FILES = ['./', 'style.css', 'app.js', 'logic.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const saved = await cache.match(request);
    const fresh = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    if (!saved) return fresh;
    event.waitUntil(fresh.catch(() => {})); // offline: the saved copy stays
    return saved;
  }));
});
