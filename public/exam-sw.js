// Alaric Exam Service Worker — offline answer caching
const CACHE = 'alaric-exam-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Cache exam assets on fetch (network-first for API calls, cache-first for static)
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Don't intercept non-GET or API calls that mutate data
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/exam/') && (url.pathname.includes('/save-answer') || url.pathname.includes('/submit') || url.pathname.includes('/snapshot'))) return;

  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request).then(cached => cached || new Response('Offline', { status: 503 }))
    )
  );
});
