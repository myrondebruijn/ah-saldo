// Offline support: answer from the saved copy at once (the shop may have no signal)
// and refresh that copy in the background.
// Change the version on every release: a new version then installs as one complete set of files.
const CACHE = 'kassa-v48';
const FILES = [
  './', 'style.css', 'app.js', 'logic.js', 'bank.js', 'sync.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs', // the PDF reader for Openbank statements, used only while importing
];

self.addEventListener('install', (event) => {
  // past the browser's own cache: GitHub Pages lets it keep a file ten minutes, which would install the old one again
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((file) => new Request(file, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
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

// A notification from the Kassa server (worker/index.js): { title, body }. A tap opens Kassa.
self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data.json();
  } catch { /* shown as just "Kassa" */ }
  event.waitUntil(Promise.all([
    self.registration.showNotification(message.title || 'Kassa', { body: message.body ?? '', icon: 'icon-192.png' }),
    caches.open('kassa-news'), // the mark that Kassa fetches from the bank when it opens next (fetchBank)
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((open) => (open[0] ? open[0].focus() : self.clients.openWindow('./'))));
});
