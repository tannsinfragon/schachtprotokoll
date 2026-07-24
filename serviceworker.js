// Schachtprotokoll Service Worker v2.8.12
const CACHE_PREFIX = 'schachtprotokoll-';
const CACHE_NAME = `${CACHE_PREFIX}2.8.12`;

// Ohne diese Dateien ist die Seite offline nicht funktionsfähig - schlägt eine
// davon fehl, bricht die Installation komplett ab (Fehler wird sichtbar statt
// dass die App auf einem halb-gecachten Stand hängen bleibt).
const CORE_ASSETS = [
    './',
    './index.html',
    './assets/js/app-config.js?v=2.8.12',
    './script.js?v=2.8.12'
];

// Verbessern die Darstellung/Funktion, ohne die App unbenutzbar zu machen -
// fehlt eine davon, wird nur gewarnt statt die ganze Installation abzubrechen.
const DEGRADIERBARE_ASSETS = [
    './schacht.css',
    './assets/vendor/zip-writer.js?v=2.8.12',
    './manifest.json',
    './assets/logo.png'
];

const OPTIONAL_ASSETS = [
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
    './assets/icons/icon-512x512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            await cache.addAll(CORE_ASSETS);
            await Promise.all(DEGRADIERBARE_ASSETS.map(asset =>
                cache.add(asset).catch(error => console.warn('[SW] Asset nicht gecacht:', asset, error))
            ));
            await Promise.all(OPTIONAL_ASSETS.map(asset =>
                cache.add(asset).catch(error => console.warn('[SW] Optionales Asset nicht gecacht:', asset, error))
            ));
        })
    );
});

self.addEventListener('message', event => {
    if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(async response => {
                    if (response.ok) {
                        const cache = await caches.open(CACHE_NAME);
                        await cache.put('./index.html', response.clone());
                    }
                    return response;
                })
                .catch(async () => {
                    const cache = await caches.open(CACHE_NAME);
                    return await cache.match('./index.html') || await cache.match('./') || Response.error();
                })
        );
        return;
    }

    const aktualisierung = caches.open(CACHE_NAME).then(cache =>
        fetch(event.request).then(response => {
            if (response.ok) return cache.put(event.request, response.clone()).then(() => response);
            return response;
        })
    );
    event.waitUntil(aktualisierung.catch(() => undefined));
    event.respondWith(caches.open(CACHE_NAME).then(async cache =>
        await cache.match(event.request) || await aktualisierung.catch(() => Response.error())
    ));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});
