/* Service worker WishTvTime — rend l'app installable et utilisable hors-ligne.
   Stratégie : "réseau d'abord" pour le document (pour récupérer les mises à jour),
   "cache d'abord" pour les fichiers statiques (icônes…). Les appels réseau externes
   (API GitHub) ne sont jamais interceptés -> ils passent directement au réseau. */
const CACHE = 'wishtvtime-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;        // GitHub API/contenu -> réseau direct (non mis en cache)

  const isDoc = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  if (isDoc) {
    // Document : réseau d'abord (MAJ), repli cache si hors-ligne
    e.respondWith(
      fetch(req).then(resp => {
        const copy = resp.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    // Statique : cache d'abord, sinon réseau (et on met en cache)
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(resp => {
        const copy = resp.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }))
    );
  }
});
