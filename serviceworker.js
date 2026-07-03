// Schachtprotokoll Service Worker v2.5.0
const cacheName = 'main_12';

const assets = [
    './',
    './index.html',
    './schacht.css',
    './assets/js/app-config.js',
    './assets/js/csv-tools.js',
    './assets/vendor/zip-writer.js',
    './script.js',
    './manifest.json',
    './assets/logo.png',
    './assets/fonts/Figtree-Regular.ttf',
    './assets/fonts/Figtree-Medium.ttf',
    './assets/fonts/Figtree-SemiBold.ttf',
    './assets/fonts/Figtree-Bold.ttf',
    './assets/icons/icon-72x72.png',
    './assets/icons/icon-96x96.png',
    './assets/icons/icon-128x128.png',
    './assets/icons/icon-144x144.png',
    './assets/icons/icon-152x152.png',
    './assets/icons/icon-192x192.png',
    './assets/icons/icon-384x384.png',
    './assets/icons/icon-512x512.png',
];

// Installieren: alle Assets cachen
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(cacheName).then(cache => cache.addAll(assets))
    );
    self.skipWaiting();
});

// Fetch: Stale-while-revalidate für App-Shell, Cache-First für Assets
self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

    event.respondWith(
        caches.open(cacheName).then(async cache => {
            const cached = await cache.match(event.request);
            const networkFetch = fetch(event.request)
                .then(response => {
                    if (response.ok) cache.put(event.request, response.clone());
                    return response;
                })
                .catch(() => null);
            // Cache-First: sofort aus Cache antworten, im Hintergrund aktualisieren
            if (cached) return cached;
            return await networkFetch || Response.error();
        })
    );
});

// Aktivieren: alte Cache-Versionen löschen
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== cacheName).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});
