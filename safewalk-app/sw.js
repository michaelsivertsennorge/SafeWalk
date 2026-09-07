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

// cache.addAll() is all-or-nothing: one 404 rejects the whole thing, and with the rejection
// swallowed that leaves offline support silently switched off — no error, no cached shell, and
// nothing to notice until someone loses signal and the app will not open. Every file is currently
// present, but a single typo in the list above would be enough. So each file is cached on its own
// and the ones that fail are named, rather than taking the rest down with them.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)));
    const failed = SHELL_FILES.filter((_, i) => results[i].status === 'rejected');
    if (failed.length) console.warn('SafeWalk: these shell files did not cache:', failed.join(', '));
  })());
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
      // back to the last good copy. A cache miss here would otherwise resolve respondWith() with
      // undefined, which the browser turns into a network error: for a navigation that means the
      // browser's offline page instead of SafeWalk, even though the shell is sitting in the cache.
      .catch(async () => {
        const hit = await caches.match(event.request);
        if (hit) return hit;
        if (event.request.mode === 'navigate') {
          const shell = (await caches.match('index.html')) || (await caches.match('./'));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
