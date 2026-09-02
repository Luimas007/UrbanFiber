/* UrbanFiber service worker — caches images aggressively (product photos,
   size charts and hero/model art are all either bundled or uniquely-named
   per upload, so a stale cache is never actually stale), while HTML/JS/CSS
   stay network-first so a new deploy is never blocked by an old cache.
   Supabase REST/RPC calls are left completely untouched. */
const VERSION = 'v1';
const STATIC_CACHE = 'uf-static-' + VERSION;
const IMG_CACHE = 'uf-img-' + VERSION;
const CACHES = [STATIC_CACHE, IMG_CACHE];

const STATIC_ASSETS = [
  'Materials/m1.jpg','Materials/m1-440.avif','Materials/m1-440.webp','Materials/m1-880.avif','Materials/m1-880.webp',
  'Materials/m2.jpg','Materials/m2-440.avif','Materials/m2-440.webp','Materials/m2-880.avif','Materials/m2-880.webp',
  'Materials/m3.jpg','Materials/m3-440.avif','Materials/m3-440.webp','Materials/m3-880.avif','Materials/m3-880.webp',
  'Materials/m4.jpg','Materials/m4-440.avif','Materials/m4-440.webp','Materials/m4-880.avif','Materials/m4-880.webp',
  'Materials/m5.jpg','Materials/m5-440.avif','Materials/m5-440.webp','Materials/m5-880.avif','Materials/m5-880.webp',
  'Materials/m6.jpg','Materials/m6-440.avif','Materials/m6-440.webp','Materials/m6-880.avif','Materials/m6-880.webp',
  'Materials/m7.jpg','Materials/m7-440.avif','Materials/m7-440.webp','Materials/m7-880.avif','Materials/m7-880.webp',
  'Materials/m8.jpg','Materials/m8-440.avif','Materials/m8-440.webp','Materials/m8-880.avif','Materials/m8-880.webp',
  'Materials/rack.jpg','Materials/rack.avif','Materials/rack.webp',
  'Materials/specs_1.jpg','Materials/specs_1-640.avif','Materials/specs_1-640.webp','Materials/specs_1-1024.avif','Materials/specs_1-1024.webp',
  'Materials/specs_2.jpg','Materials/specs_2-640.avif','Materials/specs_2-640.webp','Materials/specs_2-1024.avif','Materials/specs_2-1024.webp',
  'Materials/uf.jpg','Materials/uf.avif','Materials/uf.webp',
  'brand.jpg','brand-768.avif','brand-768.webp','brand-1280.avif','brand-1280.webp','brand-1920.avif','brand-1920.webp',
  'brand2.jpg','brand2-768.avif','brand2-768.webp','brand2-1280.avif','brand2-1280.webp','brand2-1920.avif','brand2-1920.webp'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache =>
      Promise.all(STATIC_ASSETS.map(url => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => !CACHES.includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw err;
  }
}

const IMG_EXT = /\.(jpe?g|png|webp|avif|gif|svg)(\?|$)/i;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase: only the storage/image-transform paths are cached; every
  // REST/RPC/auth call is left completely alone.
  if (url.hostname.endsWith('supabase.co')) {
    if (url.pathname.includes('/storage/')) event.respondWith(cacheFirst(req, IMG_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (IMG_EXT.test(url.pathname)) {
    event.respondWith(cacheFirst(req, IMG_CACHE));
    return;
  }

  event.respondWith(networkFirst(req, STATIC_CACHE));
});
