// Caches the app shell (HTML/CSS/JS/icons) so the app still opens when the connection drops.
// Everything that must stay live — map tiles, Nominatim/Valhalla/NVDB/Overpass, the Leaflet and
// Supabase CDNs — is left alone below, since stale copies would mean wrong map data or wrong
// directions.
//
// Network-first, not cache-first. The earlier cache-first version shipped a real bug: it returned
// the stored app.js immediately and only refreshed the cache for the *next* load, so every visit
// ran the previous release. That silently kept an old build talking to a migrated database, and
// cost us a test pin that went to localStorage instead of the server. Offline support is worth a
// cache; being one version behind on every load is not.
const CACHE_NAME = 'safewalk-shell-v3';
// geo.js was missing here until 2026-09-06. Runtime caching happened to cover it, but a user who
// installed and went offline before it was ever fetched would have got a page with every geometry
// function undefined — no distances, no ratings, no route scoring.
const SHELL_FILES = ['./', 'index.html', 'style.css', 'config.js', 'geo.js', 'app.js',
  'manifest.json', 'icon.svg', 'icon-180.png', 'icon-512.png', 'icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      // Only when the network genuinely fails — offline, or the server is unreachable — do we fall
      // back to the last good copy.
      .catch(() => caches.match(event.request))
  );
});
