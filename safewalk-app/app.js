// ---------- Storage ----------
// Ratings are not kept here. They live in the database, because a safety map that only shows what
// you personally marked is close to useless — the whole point is what everyone else found.
// Emergency contacts are the deliberate exception: they stay on the device, since there's no
// reason to upload someone's next-of-kin phone number to a server.
const CONTACTS_KEY = 'safewalk_contacts';

const loadContacts = () => JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]');
const saveContacts = (c) => localStorage.setItem(CONTACTS_KEY, JSON.stringify(c));

let pins = [];
let contacts = loadContacts();

// ---------- Backend ----------
// Reading is open to anyone: you can browse the safety map, plan a route and use SOS without an
// account. That matters for a tool people reach for when they're already uneasy — a login wall at
// the front door would be exactly the wrong thing.
//
// Writing needs an account. "One vote per person" only means something if there's a person behind
// it, and that's enforced by the votes table's (pin_id, user_id) primary key. A device id can't do
// that job: clearing browser storage would hand you a fresh identity and an unlimited ballot.
// Read before the client exists, because creating it starts the URL scan that consumes the
// fragment. A dead or already-used email link comes back as #error=...&error_description=... and
// nothing else: supabase-js finds no tokens, clears the hash, and the app opens looking perfectly
// normal — the same screen as a link that worked. Whoever followed it is left guessing.
const emailLinkError = (() => {
  const hash = (location.hash || '').slice(1);
  if (!hash.includes('error')) return '';
  return new URLSearchParams(hash).get('error_description') || '';
})();

const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
let currentUser = null;
const currentVoterId = () => (currentUser ? currentUser.id : null);

// Gate in front of every action that writes. Returns true if it may go ahead; otherwise it says
// what the sign-in is for and opens the auth sheet, so the prompt arrives with a reason attached
// rather than as a bare wall.
let authReason = '';
function requireAccount(reason) {
  if (currentUser) return true;
  authReason = reason;
  setAuthMode('signin');
  openSheet('authSheet');
  return false;
}

// ---------- Geo helpers ----------
// haversine, minDistanceToPaths, the street-graph builder, Dijkstra, polyline decoding and the
// rating bands all live in geo.js — they are pure, so they can be tested without a browser.

// Stays here rather than in geo.js: it reads the live theme tokens out of the DOM.
function ratingColor(ratio) {
  const band = ratingBand(ratio);
  if (band === 'safe') return token('--safe-strong', '#10b981');
  if (band === 'danger') return token('--danger-strong', '#f43f5e');
  return token('--mixed', '#f5c945');
}

function findNearbyPin(lat, lng, radius = 40) {
  return pins.find((p) => {
    if (p.paths) return minDistanceToPaths(lat, lng, p.paths) <= Math.max(radius, 20);
    return haversine(lat, lng, p.lat, p.lng) <= Math.max(radius, p.radius || 0);
  });
}

// Every external API this app talks to (Nominatim, Valhalla, NVDB, Overpass) is a free public
// service with no uptime guarantee — this wraps fetch() so a slow/unresponsive one fails within a
// bounded time instead of hanging the UI forever. Returns null on any failure; callers already
// treat a null/falsy result as "show a friendly fallback," so no extra error handling needed there.
// navigator.onLine only tells the truth in one direction. True can mean "joined a wifi that goes
// nowhere", so it is never trusted to mean connected — but false means the device is certain it has
// no network, and that is worth saying out loud.
//
// Used only to make a failure message specific, never to skip the attempt. The owner reported not
// being able to mark a new street offline and getting a message about a service not responding,
// which reads like the app is broken rather than like there is no signal. Marking a whole street
// genuinely needs the network — the geometry comes from Overpass — so the honest answer is to say
// so and point at what does still work.
const isOffline = () => navigator.onLine === false;

// Why the last call failed: 'timeout' | 'network' | 'http'. All three used to come back as a bare
// null, so callers could only guess, and the routing error said "taking too long to respond" even
// when the connection had failed instantly — telling someone to wait when the answer is to check
// their signal.
//
// Only meaningful immediately after a single awaited call. The hedged Overpass mirrors race several
// of these at once and will overwrite each other, which is why they do not read it.
let lastFetchFailure = null;
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  lastFetchFailure = null;
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) { lastFetchFailure = 'http'; return null; }
    return res;
  } catch (err) {
    lastFetchFailure = err && err.name === 'AbortError' ? 'timeout' : 'network';
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Roads you cannot legally or safely walk along. Marking a stretch of motorway as "safe to walk"
// would be worse than useless, so they never enter the network.
const UNWALKABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'construction', 'proposed']);

// Pulls every walkable named street around a point from OpenStreetMap's Overpass API (free, no key)
// and stitches them into a routing graph.
//
// The graph is the whole point. The previous version kept one "base" street and tried to splice
// neighbours onto its ends, which is why it misbehaved: it could only extend in the direction the
// street already ran (so turning a corner did nothing), it matched only way *endpoints* (so ordinary
// T-junctions, where one street meets another's middle, never connected), and when several streets
// met at one junction it picked whichever endpoint was marginally nearest — which is how a drag
// ended up on the wrong street. With a real graph, "which streets connect here" is simply a fact
// about the data instead of a guess.
// Overpass is free and has no SLA, and its main mirror really does fall over: measured here, the
// same query returned 200 in 8.6s once and a 504 fourteen seconds later. So we ask several mirrors
// at once and take the first that actually answers, rather than waiting out a dead one.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// How long the first mirror gets before the second is asked as well. Long enough that a healthy
// mirror is never doubled up on, short enough that a stalled one does not hold up the picker.
const HEDGE_AFTER_MS = 2500;

// Radius dominates the cost, roughly quadratically. Measured in central Oslo: 300m came back in
// 2.0s and 25KB; 700m took 14.4s and then failed outright. So the picker opens on a small fast
// fetch and quietly widens afterwards — see startStreetPicker.
const NEAR_RADIUS_M = 200;
const WIDE_RADIUS_M = 500;
// The startup guess is deliberately smaller than the widen. Including unnamed connecting ways on
// 2026-09-07 made these queries about five times heavier — measured in central Oslo: 500m is 1.1MB,
// 300m is 494KB, 200m is 204KB. WIDE_RADIUS_M is fine where it is used, because by then the person
// has opened the picker and is waiting. Spending 1.1MB of someone's data plan the moment they open
// a safety app, on a street they may never mark, is a different thing entirely — and since a tap
// beyond the loaded network now fetches what it needs on demand, this is only ever saving a second.
const PREFETCH_RADIUS_M = 300;

// Street geometry is cached across sessions, not just within one. Measured, the same 200m query
// against Overpass ranged from 0.6s to over 10s depending on server load and how recently we had
// asked — so the only way this reliably feels fast is to already have the answer. OSM road geometry
// barely changes, so a week-old copy is fine.
// Cached ways only mean anything alongside the query that produced them, so the key carries a
// version. Dropping [name] from overpassQuery on 2026-09-07 made every cached entry wrong — a
// week of stale, disconnected street networks that no amount of updating the app would have
// cleared, because the cache outlives the code. Bump this whenever overpassQuery changes.
const STREET_CACHE_KEY = 'safewalk_street_cache_v2';
const STREET_CACHE_LEGACY_KEYS = ['safewalk_street_cache'];
const STREET_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STREET_CACHE_MAX = 8; // a few square kilometres; comfortably inside the localStorage budget

let streetNetworkCache = loadStreetCache(); // [{ lat, lng, radius, ways, at }]

function loadStreetCache() {
  try { STREET_CACHE_LEGACY_KEYS.forEach((k) => localStorage.removeItem(k)); } catch {}
  try {
    const raw = JSON.parse(localStorage.getItem(STREET_CACHE_KEY) || '[]');
    const fresh = raw.filter((e) => e && e.at && Date.now() - e.at < STREET_CACHE_TTL_MS && Array.isArray(e.ways));
    return fresh;
  } catch {
    return [];
  }
}

function saveStreetCache() {
  try {
    localStorage.setItem(STREET_CACHE_KEY, JSON.stringify(streetNetworkCache.slice(0, STREET_CACHE_MAX)));
  } catch {
    // Quota exceeded, or storage disabled. The in-memory copy still works for this session.
  }
}

// Any cached disc that fully contains the requested one answers the question already — which is what
// makes the startup prefetch pay off, since marking usually happens near where you are standing.
function cachedCovering(lat, lng, radius) {
  for (const e of streetNetworkCache) {
    if (haversine(lat, lng, e.lat, e.lng) + radius <= e.radius) return e.ways;
  }
  return null;
}

function rememberStreets(lat, lng, radius, ways) {
  streetNetworkCache = streetNetworkCache.filter(
    (e) => !(Math.abs(e.lat - lat) < 1e-6 && Math.abs(e.lng - lng) < 1e-6 && e.radius === radius)
  );
  streetNetworkCache.unshift({ lat, lng, radius, ways, at: Date.now() });
  streetNetworkCache = streetNetworkCache.slice(0, STREET_CACHE_MAX);
  saveStreetCache();
}

function overpassQuery(lat, lng, radius) {
  // Filtering unwalkable roads in the query rather than after it keeps the payload down; there is
  // no point downloading a motorway we would only throw away.
  //
  // Unnamed ways ARE downloaded, and that matters more than it looks. This asked for [name] until
  // 2026-09-07, which meant slip roads, service roads, alleys, footpaths and roundabout links —
  // the things that physically join one named street to the next — were never fetched. Two streets
  // that plainly connect in real life then had no path between them, which is exactly what was
  // reported from a walk.
  //
  // Measured around Frogner: with [name], 5% of the network was reachable from a starting point
  // and the target could not be reached at all. Without it, 99% and the target reachable. In dense
  // central Oslo it made no difference — which is why an earlier check nearly dismissed it — so
  // this only shows up away from the centre, i.e. across most of the country.
  //
  // The cost is real and worth stating: at the 200m picker radius the payload goes from about
  // 18KB to 89KB, and the request from 0.46s to 0.59s. Five times the bytes for a feature that
  // otherwise does not work outside a city centre.
  const excluded = [...UNWALKABLE].join('|');
  return `[out:json][timeout:25];way(around:${radius},${lat},${lng})[highway][highway!~"^(${excluded})$"];out geom;`;
}

const inFlightOverpass = new Map(); // dedupes concurrent identical requests (prefetch racing a tap)

async function fetchOverpassWays(lat, lng, radius) {
  const covered = cachedCovering(lat, lng, radius);
  if (covered) return covered;

  const key = `${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  if (inFlightOverpass.has(key)) return inFlightOverpass.get(key);

  const query = overpassQuery(lat, lng, radius);
  const attempt = async (base) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(`${base}?data=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json(); // a rate-limited mirror answers with XML, so this throws too
      const ways = (data.elements || []).filter(
        // No name requirement here either. It used to demand one, which silently undid the point
        // of dropping [name] from the query — the unnamed alleys and slip roads that join streets
        // together arrived and were thrown away on the doorstep.
        (el) => el.type === 'way' && el.geometry && el.tags && !UNWALKABLE.has(el.tags.highway)
      );
      if (!ways.length) throw new Error('empty');
      return ways;
    } finally {
      clearTimeout(timer);
    }
  };

  // Hedged rather than raced. Asking every mirror at once did protect against a dead one, but it
  // downloaded the whole answer from each — and since unnamed connecting ways were included on
  // 2026-09-07 a single answer can be several hundred KB, on what may be someone's mobile data.
  //
  // So the second mirror only starts if the first has not answered within HEDGE_AFTER_MS, or has
  // already failed — no point waiting out the hedge on a mirror that is plainly down. The usual
  // case now pays for one response instead of two; the protection is unchanged.
  const backupTimer = { id: null };
  const first = attempt(OVERPASS_MIRRORS[0]);
  const second = new Promise((resolve, reject) => {
    const start = () => attempt(OVERPASS_MIRRORS[1]).then(resolve, reject);
    backupTimer.id = setTimeout(start, HEDGE_AFTER_MS);
    first.then(
      () => clearTimeout(backupTimer.id),          // already answered; never ask the second
      () => { clearTimeout(backupTimer.id); start(); }
    );
  });

  const job = Promise.any([first, second])
    .then((ways) => { rememberStreets(lat, lng, radius, ways); return ways; })
    .catch(() => null) // every mirror failed
    .finally(() => inFlightOverpass.delete(key));

  inFlightOverpass.set(key, job);
  return job;
}

async function fetchStreetNetwork(lat, lng, radius = NEAR_RADIUS_M) {
  const ways = await fetchOverpassWays(lat, lng, radius);
  return ways ? buildStreetGraph(ways) : null;
}

// Warms the cache before the user asks. Opening the report sheet is a strong hint that "Street" may
// be tapped next, and starting the fetch there usually means it has already landed by the time it
// is needed. Failures are ignored on purpose — this is a guess, not a request.
function prefetchStreetNetwork(lat, lng) {
  fetchOverpassWays(lat, lng, NEAR_RADIUS_M).catch(() => {});
}

// The single biggest win available: you can only rate places within 1 km of yourself, so the app
// already knows roughly which streets you might mark before you have tapped anything. Fetching the
// wide radius around your position at startup means the picker usually opens from cache instead of
// waiting on a server whose latency we measured swinging between 0.6s and 10s.
// Respect a phone that has asked us not to spend its data on guesses. Data Saver being on, or a 2G
// connection, both mean the person is counting bytes — and this request is speculative by nature.
function dataIsPrecious() {
  const c = navigator.connection;
  if (!c) return false;
  return !!c.saveData || ['slow-2g', '2g'].includes(c.effectiveType);
}

function prefetchAroundUser(lat, lng) {
  if (dataIsPrecious()) return;                             // they asked; the on-demand path still works
  if (cachedCovering(lat, lng, PREFETCH_RADIUS_M)) return;  // already covered, don't spend the request
  setTimeout(() => fetchOverpassWays(lat, lng, PREFETCH_RADIUS_M).catch(() => {}), 2500);
}

// Only people who are actually near a street can rate it — keeps ratings grounded in lived experience
// instead of remote drive-by trolling.
const RATING_RADIUS_M = 1000;
function withinRatingRange(lat, lng) {
  return !!userLocation && haversine(userLocation.lat, userLocation.lng, lat, lng) <= RATING_RADIUS_M;
}

// The same question asked about a whole pin. For a marked street that means the nearest point ON
// it, not its stored midpoint. The midpoint is itself a point on the path, so it is never closer
// than the nearest point — the error only ever went one way, refusing a rating for a street the
// person was standing on because the middle of the chain was over a kilometre further along.
function withinRatingRangeOfPin(p) {
  if (!userLocation || !p) return false;
  const near = p.paths ? nearestPointOnPaths(userLocation.lat, userLocation.lng, p.paths) : null;
  const dist = near ? near.dist : haversine(userLocation.lat, userLocation.lng, p.lat, p.lng);
  return dist <= RATING_RADIUS_M;
}

let toastTimer = null;
function showToast(msg, ms = 2600) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// A short, light tick on key confirmations (rating saved, SOS confirmed, report deleted) — cheap
// to add, and genuinely useful one-handed at night when you can't always look straight at the screen.
function buzz(ms = 20) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// Swaps an element's text for a spinner + message while something is in flight, so an async wait
// reads as "working," not "did my tap even register." Call again with plain text to clear it.
function setLoadingStatus(el, text) {
  el.innerHTML = '';
  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  el.appendChild(spinner);
  el.appendChild(document.createTextNode(text));
}

// Every Supabase call in this file was written as `const { error } = await ...`, which assumes
// failure always arrives as a value. It does not. A phone with no signal makes fetch REJECT, so the
// await throws, every line after it is skipped, and whatever was on screen stays exactly as it was.
//
// That single assumption produced three separate bugs reported from a real phone on 2026-09-08:
// a mark that sat on the map looking saved while nothing was ever written; "Saving your new
// password…" spinning forever after the password had in fact changed; and a sign-out that appeared
// to do nothing. None of them logged anything a walker would ever see.
//
// This turns a thrown call back into the { data, error } shape every caller was already written
// for, so the existing error handling — which was fine — finally gets to run.
// Nothing may wait forever. A request that has not answered in this long is not going to, and a
// spinner that never clears is worse than an error: it tells someone the app is working on their
// problem when nothing is happening at all.
const SETTLED_TIMEOUT_MS = 20000;

async function settled(call, what) {
  try {
    return await Promise.race([
      call,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), SETTLED_TIMEOUT_MS)),
    ]);
  } catch (thrown) {
    // navigator.onLine lies in one direction — a wifi that goes nowhere still reports true — so a
    // fetch that threw is treated as a lost connection whatever it claims. And the browser's own
    // wording ("Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource")
    // is not a sentence to hand someone walking home; say the one thing that is true and useful.
    const raw = (thrown && thrown.message) || '';
    if (raw === 'timed out') {
      return { data: null, error: { message: 'That took too long and was given up on. Try again.', threw: true } };
    }
    const networkish = !raw || /fetch|network|load failed|connection/i.test(raw);
    const message = (isOffline() || networkish)
      ? 'No connection just now, so this could not be saved.'
      : raw;
    return { data: null, error: { message, threw: true } };
  }
}

// settled() only covers the call. An exception ANYWHERE ELSE in an async click handler — a missing
// element after a half-applied update, a typo on a rare branch — stops the function silently and
// leaves whatever was on screen, which when a spinner is on screen is a spinner that never clears.
// That has now produced three separate "it just keeps loading" reports from a real phone, each with
// a different underlying cause, which is the signal that the shape of the handler is the problem
// rather than any one bug inside it.
//
// So: every handler that puts a spinner up goes through here, and a throw always ends in a message.
// The rule the incident bug taught, written down so the next async handler gets it for free.
//
// A SYNCHRONOUS click handler cannot run twice over itself: the event loop finishes it before the
// next tap is dispatched, which is why the rating and route-feedback buttons are safe with only
// their own state guards. A handler that AWAITS is a different animal — the gap between the await
// and the write is wide open, and twelve taps landed twelve identical assault reports in it.
//
// So: anything that awaits before writing gets wrapped in this.
function onceAtATime(fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try {
      await fn(...args);
    } finally {
      running = false;
    }
  };
}

function guarded(statusId, fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      const el = statusId && document.getElementById(statusId);
      if (el) el.textContent = 'Something went wrong on this screen — nothing was saved. Try again, and reload the app if it keeps happening.';
      else showToast('Something went wrong — nothing was saved.');
      console.error('SafeWalk: handler failed', err);
    }
  };
}

// In-app replacement for window.confirm() — native confirm/alert/prompt dialogs are known to
// silently no-op in some browsers' installed/standalone PWA mode (this app's manifest enables
// that install), which would look exactly like "the button doesn't do anything."
let confirmResolve = null;
function showConfirm(message, { okLabel = 'Confirm', title = 'Are you sure?' } = {}) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  document.getElementById('confirmOkBtn').textContent = okLabel;
  openSheet('confirmSheet');
  return new Promise((resolve) => { confirmResolve = resolve; });
}

// Three fixed bands instead of a continuous gradient: >75% safe reads unambiguously as safe,
// <50% safe (i.e. more than half unsafe reports) reads unambiguously as unsafe, and the wide
// middle ground where opinion is genuinely split shows as a distinct "mixed" color rather than
// a shade that could be misread either way.
const DEFAULT_CENTER = [59.9139, 10.7522]; // fallback: Oslo, Norway
let map = L.map('map', { zoomControl: false, attributionControl: true }).setView(DEFAULT_CENTER, 15);
L.control.zoom({ position: 'bottomleft' }).addTo(map);

// Free dark tile services (CARTO, Stadia, etc.) now gate their good dark styles behind an API key,
// so instead of depending on one, the standard free OSM tiles get CSS-inverted to a dark theme
// (see .leaflet-tile-pane in style.css) — same trick many "dark mode" map apps use.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const pinLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const lightingLayer = L.layerGroup().addTo(map);

// ---------- Street lighting overlay ----------
// Sourced live from NVDB (Statens vegvesen's National Road Database), object type 86
// "Belysningsstrekning" — official road stretches registered as lit. Free, no API key.
// Fails silently: this is a supplementary layer, not core functionality.
let lightingLoadedFor = null;

function boundsKey(b) {
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(3)).join(',');
}


let loggedLightingFailure = false;
// The map key used to read "Lit streets (official data)" whether or not a single lit street had
// been drawn, so an empty map looked identical whether nobody has mapped lighting here, the API
// refused us, or you are simply zoomed too far out. On a map that is mostly empty to begin with,
// a legend entry for a layer that is not there is worse than no entry: it makes the user doubt
// their own eyes rather than the data.
function setLightingLegend(state, count) {
  const el = document.getElementById('legendLighting');
  if (!el) return;
  el.textContent = {
    loading: 'Lit streets — checking…',
    ok: `Lit streets (official data)${count ? ` — ${count} here` : ''}`,
    none: 'Lit streets — none recorded in this view',
    zoom: 'Lit streets — zoom in to load',
    failed: 'Lit streets — data unavailable right now',
  }[state] || 'Lit streets (official data)';
  el.classList.toggle('legend-muted', state !== 'ok');
}

async function loadLighting() {
  if (map.getZoom() < 14) { setLightingLegend('zoom'); return; } // huge queries when zoomed out
  const b = map.getBounds();
  const key = boundsKey(b);
  if (key === lightingLoadedFor) return;
  lightingLoadedFor = key;
  // A map that has not been laid out yet reports zero size, and Leaflet then hands back a bounds
  // with no span at all. Asking the server about a box of zero area is meaningless, and the reply
  // would surface as "data unavailable" — blaming the API for what is really a map that has not
  // been drawn yet.
  if (b.getEast() === b.getWest() || b.getNorth() === b.getSouth()) {
    lightingLoadedFor = null;   // try again once the map has a size
    setLightingLegend('loading');   // never leave the default standing; it claims a layer
    return;
  }
  // NVDB's cost grows with the area asked for — measured through our proxy on central Oslo: 9KB
  // and 17 segments at 0.02°, 46KB at 0.04°, 111KB and 88 segments at 0.08°, all under a second.
  // Past roughly 0.12° the server refuses outright, which would surface as "data unavailable" for
  // the whole view, so the box is clamped around the centre instead.
  //
  // A safety net, not a working limit: measured on a 520x1200 map, zoom 14 asks for 0.052° and
  // zoom 15 for 0.026°, both well inside it, so at the zoom-14 threshold above the clamp never
  // binds and coverage is always the whole view. It only starts trimming at zoom 13 and below,
  // which is also why the threshold stays where it is — half-covered lighting would read as
  // "these streets are lit and those are not" when the truth is that we never asked.
  const MAX_LIGHTING_SPAN_DEG = 0.09;
  const c = b.getCenter();
  const halfLng = Math.min((b.getEast() - b.getWest()) / 2, MAX_LIGHTING_SPAN_DEG / 2);
  const halfLat = Math.min((b.getNorth() - b.getSouth()) / 2, MAX_LIGHTING_SPAN_DEG / 2);
  const bbox = `${c.lng - halfLng},${c.lat - halfLat},${c.lng + halfLng},${c.lat + halfLat}`;
  try {
    // Through our own backend, not NVDB directly. NVDB rejects any User-Agent that does not look
    // like a browser, and a browser cannot set that header — User-Agent is forbidden to fetch(),
    // so the browser sends its own and NVDB refuses that too. Confirmed from a real Chrome on the
    // live site: 400, code 4017. This layer was therefore impossible from the client since the day
    // it shipped, on every device. The edge function can set the header, so now it works.
    const url = `${SUPABASE_URL}/functions/v1/lit-streets?bbox=${bbox}`;
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res) {
      lightingLoadedFor = null;   // let a later attempt retry rather than caching the failure
      setLightingLegend('failed');
      if (!loggedLightingFailure) {
        loggedLightingFailure = true;
        console.warn('SafeWalk: could not load lit-street data via the lit-streets function.');
      }
      return;
    }
    const data = await res.json();
    let drawn = 0;
    lightingLayer.clearLayers();
    (data.lines || []).forEach((wkt) => {
      if (!wkt || !wkt.startsWith('LINESTRING')) return;
      const pts = parseWktLineStringZ(wkt);
      if (!pts) return;   // unparseable or out of range: skip rather than draw it wrong
      L.polyline(pts, {
        color: token('--mixed', '#facc15'),
        weight: 3,
        opacity: 0.5,
        interactive: false,
      }).addTo(lightingLayer);
      drawn++;
    });
    // Empty and broken look identical on the map; only the key can tell them apart.
    setLightingLegend(drawn ? 'ok' : 'none', drawn);
  } catch {
    setLightingLegend('failed');    // supplementary layer: explain it, never break the map for it
  }
}
map.on('moveend', loadLighting);

// ---------- Police incidents (Politiloggen, politiet.no, NLOD 2.0) ----------
// A different kind of claim from a community rating, and drawn differently on purpose: this is what
// the police reported, not what a neighbour felt. Only categories bearing on personal safety on
// foot are mirrored (violence and public order), and only while still recent — see the
// politiloggen-sync edge function for how location and precision are decided.
//
// These are shown, not folded into the route score. An official report is evidence a person should
// weigh themselves, and quietly moving a route because of one would hide the reason.
const policeLayer = L.layerGroup().addTo(map);
let policeEvents = [];

// How often the client re-asks. Not only for freshness: this ran exactly once, at page load, so a
// single dropped connection meant no police layer AND no proximity warning for as long as the app
// stayed open — and a walk home is exactly when the app has been open for a while.
const POLICE_REFRESH_MS = 5 * 60 * 1000;

// The layer's own line in the map key, and the fifth instance in this project of the same bug: a
// failure that is indistinguishable from good news. "No police reports near you" and "we could not
// find out whether there are any" looked identical — both were a map with no red on it — and the
// second one is the reassuring reading of the two, which is the wrong way for a safety app to fail.
function setPoliceLegend(state, count) {
  const el = document.getElementById('legendPolice');
  if (!el) return;
  el.textContent = {
    loading: 'Police reports — checking…',
    ok: `Police report (recent)${count ? ` — ${count} here` : ''}`,
    none: 'Police reports — none active nearby',
    failed: 'Police reports — could not be loaded',
  }[state] || 'Police report (recent)';
  el.classList.toggle('legend-muted', state !== 'ok');
}

async function loadPoliceEvents() {
  if (!sb) { setPoliceLegend('failed'); return; }   // the pins path reports this; one banner is enough
  setPoliceLegend('loading');
  const { data, error } = await settled(sb
    .from('police_events')
    .select('id,category,area,municipality,text_body,radius_m,precision_label,is_active,occurred_at,expires_at,geom')
    .gt('expires_at', new Date().toISOString()), 'load police reports');
  if (error || !Array.isArray(data)) { setPoliceLegend('failed'); return; }

  policeEvents = data
    .map((r) => {
      const p = parsePointEwkb(r.geom);
      return p ? { ...r, lat: p.lat, lng: p.lng } : null;
    })
    .filter(Boolean);
  setPoliceLegend(policeEvents.length ? 'ok' : 'none', policeEvents.length);
  renderPoliceEvents();
  checkPoliceProximity();
  checkIncidentProximity();
}


function renderPoliceEvents() {
  policeLayer.clearLayers();
  // Several reports often share one area, because the police name a district rather than a street.
  // Drawing one circle per report would stack identical rings and imply more than we know.
  const byPlace = new Map();
  policeEvents.forEach((e) => {
    const key = `${e.lat.toFixed(5)},${e.lng.toFixed(5)},${e.radius_m || 0}`;
    if (!byPlace.has(key)) byPlace.set(key, []);
    byPlace.get(key).push(e);
  });

  byPlace.forEach((group) => {
    const first = group[0];
    const circle = L.circle([first.lat, first.lng], {
      radius: first.radius_m || 250,
      color: token('--danger-strong', '#f43f5e'),
      weight: 2,
      dashArray: '3 6',
      fillColor: token('--danger-strong', '#f43f5e'),
      fillOpacity: 0.1,
      className: 'police-area',
    });
    circle.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (trimState) { handleStreetPick(ev.latlng.lat, ev.latlng.lng); return; }
      openPoliceSheet(group);
    });
    circle.addTo(policeLayer);
  });
}

function openPoliceSheet(group) {
  const first = group[0];
  document.getElementById('policeTitle').textContent = `Police reports — ${first.area || first.municipality}`;
  // Say plainly how precise this is. The police named an area, not a spot, and the circle is that
  // area; pretending otherwise would send someone round a corner for no reason.
  document.getElementById('policePrecision').textContent = first.radius_m
    ? `Somewhere in this area — the police named “${first.area}”, roughly ${first.radius_m >= 1000 ? (first.radius_m / 1000).toFixed(1) + ' km' : first.radius_m + ' m'} across. Not a specific address.`
    : 'Location approximate.';
  const list = document.getElementById('policeList');
  list.innerHTML = '';
  group
    .slice()
    .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
    .forEach((e) => {
      const div = document.createElement('div');
      div.className = 'police-item';
      // "25 minutes ago" answers the only question being asked of a police report — is this
      // happening now? — where an absolute timestamp makes you do the subtraction yourself in
      // the dark. The exact time stays in the title for anyone who wants it.
      const stamp = e.occurred_at ? new Date(e.occurred_at) : null;
      const when = stamp ? describeAge(Date.now() - stamp.getTime()) : '';
      div.innerHTML = `<div class="police-item-top"><span class="police-cat">${escapeHtml(e.category || 'Incident')}</span><span class="police-when" title="${escapeHtml(stamp ? stamp.toLocaleString() : "")}">${escapeHtml(when)}</span></div>`;
      const body = document.createElement('p');
      body.className = 'police-text';
      body.textContent = e.text_body || '';   // textContent, not innerHTML: this is third-party text
      div.appendChild(body);
      list.appendChild(div);
    });
  openSheet('policeSheet');
}


// ---------- "Something is happening near you" ----------
// The point of mirroring police reports is that someone walking home learns about an ongoing
// operation near them without having to think to look. So this checks proximity whenever either
// the events or the position change, and says so once.
//
// Only ongoing operations raise the alert. A brawl that the police have finished dealing with is
// worth seeing on the map, but waking someone's phone about it would be crying wolf, and an alert
// people learn to dismiss is worse than no alert.
const POLICE_ALERT_MARGIN_M = 250; // "in or just outside the area the police described"
const alertedPoliceIds = new Set();

// The owner asked for a warning when there is an operation near where you are. It gated on
// e.is_active — and that flag does not mean what it looks like it means. Measured on a live
// Politiloggen feed: 3 of 50 messages had it set, all of them standing royal-visit press notices,
// while every message of an actual grenade cordon had it false. So the warning almost never fired,
// including standing directly on top of a live report in Tromsø, which is how this was found.
//
// Recency is already handled upstream: loadPoliceEvents only asks for rows still inside their TTL,
// and the sync sets that from the incident's own timestamps. Anything near you that survived that
// is worth telling you about; is_active only decides the wording.
function checkPoliceProximity() {
  if (!userLocation || !policeEvents.length) return;
  const near = policeEvents.filter((e) => {
    if (alertedPoliceIds.has(e.id)) return false;
    const d = haversine(userLocation.lat, userLocation.lng, e.lat, e.lng);
    return d <= (e.radius_m || 250) + POLICE_ALERT_MARGIN_M;
  });
  if (!near.length) return;
  near.forEach((e) => alertedPoliceIds.add(e.id));
  showPoliceAlert(near);
}


// Politiloggen's categories are Norwegian and read badly dropped into an English sentence
// ("an ongoing voldshendelse"). The map keeps the original label; this is only for prose.
const CATEGORY_EN = {
  'voldshendelse': 'violent incident',
  'ro og orden': 'public disturbance',
  'trafikk': 'traffic incident',
  'brann': 'fire',
  'savnet': 'missing person case',
  'andre hendelser': 'incident',
};
function describeCategory(c) {
  return CATEGORY_EN[String(c || '').toLowerCase()] || 'police operation';
}

function showPoliceAlert(events) {
  const el = document.getElementById('policeAlert');
  if (!el) return;
  // The banner is shared with user reports, so clear their styling — a police warning wearing the
  // community colour, or the reverse, is the one confusion this layer must never cause.
  el.classList.remove('alert-user-report');
  const first = events[0];
  const what = describeCategory(first.category);
  const where = first.area ? `near ${first.area}` : 'near you';
  // Only say "ongoing" when the police actually flagged it so. Everything else gets its age, which
  // is the honest version — "reported 20 minutes ago" tells you what you need without pretending
  // to know whether anyone is still there.
  const when = first.occurred_at ? describeAge(Date.now() - new Date(first.occurred_at).getTime()) : '';
  el.querySelector('.police-alert-text').textContent = events.length === 1
    ? (first.is_active
        ? `Police report an ongoing ${what} ${where}.`
        : `Police reported a ${what} ${where}${when ? `, ${when}` : ''}.`)
    : `${events.length} police reports near you.`;
  el.hidden = false;
  buzz();
  // Tapping opens the detail, so the alert is a way in rather than just a scare.
  el.onclick = () => { el.hidden = true; openPoliceSheet(events); };
  const dismiss = el.querySelector('.police-alert-dismiss');
  if (dismiss) dismiss.onclick = (ev) => { ev.stopPropagation(); el.hidden = true; };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let userLocation = null;
let pendingPoint = null; // {lat, lng} awaiting a new report
let pendingRadius = null; // meters — set when the report came from a press-and-hold area mark

// ---------- "You are here" marker ----------
let userMarker = null;
let userAccuracyCircle = null;
let userRangeCircle = null;
const userDotIcon = L.divIcon({
  className: '',
  html: '<div class="user-dot"><div class="user-dot-pulse"></div></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function updateUserMarker(lat, lng, accuracy) {
  if (!userMarker) {
    userMarker = L.marker([lat, lng], { icon: userDotIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }
  if (accuracy) {
    if (!userAccuracyCircle) {
      userAccuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        color: token('--you', '#4a9eff'),
        weight: 1,
        fillColor: token('--you', '#4a9eff'),
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    } else {
      userAccuracyCircle.setLatLng([lat, lng]);
      userAccuracyCircle.setRadius(accuracy);
    }
  }
  // Shows the 1km rating boundary proactively, instead of only telling people "too far" after
  // they've already tapped and picked a rating.
  if (!userRangeCircle) {
    userRangeCircle = L.circle([lat, lng], {
      radius: RATING_RADIUS_M,
      color: '#8b93a8',
      weight: 1.5,
      dashArray: '4 8',
      fill: false,
      interactive: false,
    }).addTo(map);
  } else {
    userRangeCircle.setLatLng([lat, lng]);
  }
}

function renderPins() {
  pinLayer.clearLayers();
  pins.forEach((p) => {
    const total = p.safe + p.danger;
    const ratio = total ? p.safe / total : 0.5;
    const color = ratingColor(ratio);
    const dashArray = ratingDash(ratio);
    const onClick = (e) => {
      L.DomEvent.stopPropagation(e);
      // While picking a street, an existing mark lying on top must not swallow the tap — otherwise
      // you couldn't route through anywhere already rated.
      if (trimState) { handleStreetPick(e.latlng.lat, e.latlng.lng); return; }
      lastTapLatLng = { lat: e.latlng.lat, lng: e.latlng.lng }; // where they actually touched, not the pin's centre
      openPinSheet(p.id);
    };
    // 'pin-shape' marks these as ours, so press-and-hold can start a new mark on top of them while
    // still keeping its hands off route lines, route endpoints and street trim handles.
    if (p.paths) {
      p.paths.forEach((path) => {
        L.polyline(path, { color, weight: 6, opacity: 0.65, dashArray, className: 'pin-shape' }).on('click', onClick).addTo(pinLayer);
      });
      return;
    }
    const marker = p.radius
      ? L.circle([p.lat, p.lng], { radius: p.radius, color, weight: 3, dashArray, fillColor: color, fillOpacity: 0.28, className: 'pin-shape' })
      : L.circleMarker([p.lat, p.lng], { radius: Math.min(18, 9 + total), color, weight: 3, dashArray, fillColor: color, fillOpacity: 0.55, className: 'pin-shape' });
    marker.on('click', onClick);
    marker.addTo(pinLayer);
  });
}

let suppressNextMapClick = false;
// The last place the map was touched. Used by "Mark something else here" so a new mark lands where
// the finger was, not on the centre of whatever pin happened to intercept the tap.
let lastTapLatLng = null;

map.on('click', (e) => {
  if (suppressNextMapClick) {
    suppressNextMapClick = false;
    return;
  }
  const { lat, lng } = e.latlng;
  if (pickingSide) {
    handleMapPick(lat, lng);
    return;
  }
  if (trimState) { handleStreetPick(lat, lng); return; }
  lastTapLatLng = { lat, lng };
  const nearby = findNearbyPin(lat, lng);
  if (nearby) {
    openPinSheet(nearby.id);
  } else {
    if (!withinRatingRange(lat, lng)) {
      showToast('You can only rate spots within 1 km of your current location.');
      return;
    }
    pendingPoint = { lat, lng };
    pendingRadius = null;
    openReportSheet();
  }
  document.getElementById('mapHint').classList.add('hidden');
});

// ---------- Press-and-hold to mark a bigger area ----------
// A quick tap keeps using the click handler above (existing point-rating flow).
// Holding still past a short threshold instead grows a circle live, and releasing
// opens the same report sheet but for that whole marked area.
const HOLD_THRESHOLD_MS = 300;
const HOLD_MAX_MS = 2200;
const HOLD_MIN_RADIUS_M = 12;
const HOLD_MAX_RADIUS_M = 120;
const HOLD_MOVE_CANCEL_PX = 12;

let press = null;

function pixelDist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function beginGrow() {
  if (!press) return;
  press.confirmed = true;
  suppressNextMapClick = true;
  setTimeout(() => { suppressNextMapClick = false; }, 500); // safety net: never let this flag get stuck
  map.dragging.disable();
  press.circle = L.circle(press.latlng, {
    radius: HOLD_MIN_RADIUS_M,
    color: token('--mixed', '#f5c945'),
    weight: 2,
    dashArray: '4 5',
    fillColor: token('--mixed', '#f5c945'),
    fillOpacity: 0.22,
    interactive: false,
  }).addTo(map);
  press.growStart = performance.now();
  const step = (ts) => {
    if (!press || !press.confirmed) return;
    const t = Math.min(1, (ts - press.growStart) / HOLD_MAX_MS);
    press.circle.setRadius(HOLD_MIN_RADIUS_M + (HOLD_MAX_RADIUS_M - HOLD_MIN_RADIUS_M) * t);
    if (t < 1) press.growRAF = requestAnimationFrame(step);
  };
  press.growRAF = requestAnimationFrame(step);
  if (navigator.vibrate) navigator.vibrate(15);
}

function endPress(cancelled) {
  if (!press) return;
  clearTimeout(press.longPressTimer);
  if (press.growRAF) cancelAnimationFrame(press.growRAF);
  const wasConfirmed = press.confirmed;
  const latlng = press.latlng;
  const radius = wasConfirmed ? Math.round(press.circle.getRadius()) : 0;
  if (wasConfirmed) {
    map.removeLayer(press.circle);
    map.dragging.enable();
  }
  press = null;
  if (cancelled || !wasConfirmed) return; // a plain tap: let the ordinary map 'click' handler deal with it

  if (!withinRatingRange(latlng.lat, latlng.lng)) {
    showToast('You can only rate spots within 1 km of your current location.');
    return;
  }
  pendingPoint = { lat: latlng.lat, lng: latlng.lng };
  pendingRadius = radius;
  openReportSheet();
  document.getElementById('mapHint').classList.add('hidden');
}

function onMapPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  if (pickingSide) return; // route-endpoint picking stays a simple tap, no hold behavior
  // Route lines, route endpoints and trim handles keep the map's hands off. Our own pin shapes are
  // the exception: an area circle can cover a whole block, and refusing to start a press on top of
  // one meant there was no way to mark a street running under it. Tap still inspects the pin — it's
  // only the hold that adds something new, so neither gesture blocks the other.
  const hit = e.target.closest('.leaflet-interactive, .leaflet-marker-icon');
  if (hit && !hit.classList.contains('pin-shape')) return;
  if (press) { endPress(true); return; } // a second finger touched down — bail out to normal pinch/pan
  const startContainerPoint = map.mouseEventToContainerPoint(e);
  press = {
    latlng: map.containerPointToLatLng(startContainerPoint),
    startContainerPoint,
    confirmed: false,
    circle: null,
    growRAF: null,
    growStart: 0,
    longPressTimer: setTimeout(beginGrow, HOLD_THRESHOLD_MS),
  };
}

function onMapPointerMove(e) {
  if (!press || press.confirmed) return;
  const p = map.mouseEventToContainerPoint(e);
  if (pixelDist(p, press.startContainerPoint) > HOLD_MOVE_CANCEL_PX) {
    clearTimeout(press.longPressTimer);
    press = null; // treat as a pan, not a hold
  }
}

const mapContainer = map.getContainer();
mapContainer.addEventListener('pointerdown', onMapPointerDown);
mapContainer.addEventListener('pointermove', onMapPointerMove);
mapContainer.addEventListener('pointerup', () => endPress(false));
mapContainer.addEventListener('pointercancel', () => endPress(true));

function locate(recenter = true) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        checkPoliceProximity();
        checkIncidentProximity();
        updateUserMarker(userLocation.lat, userLocation.lng, pos.coords.accuracy);
        if (recenter) map.setView([userLocation.lat, userLocation.lng], 16);
        renderPins();
        prefetchAroundUser(userLocation.lat, userLocation.lng);
        resolve(userLocation);
      },
      () => {
        renderPins();
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
    );
  });
}

document.getElementById('locateBtn').addEventListener('click', () => {
  // We already have a live, continuously-updated fix from the background watcher (used for the
  // 1km rating gate, SOS, etc.) — reuse it instantly instead of forcing a brand-new GPS request,
  // which is what was causing the multi-second delay on every tap.
  if (userLocation) {
    map.setView([userLocation.lat, userLocation.lng], 16);
    return;
  }
  const btn = document.getElementById('locateBtn');
  btn.classList.add('loading');
  locate(true).finally(() => btn.classList.remove('loading'));
});

// ---------- Sheets ----------
const backdrop = document.getElementById('backdrop');
// Keyboard/screen-reader users need focus actually moved into the dialog (and back out again on
// close) — a visual-only sheet with no focus management is invisible to anyone not using a mouse.
let lastFocusedBeforeSheet = null;
// The `hidden` attribute is the authoritative visibility switch (forces display:none in every
// browser, no exceptions) — the .open class + transform only controls the slide animation on top
// of that. Belt-and-suspenders: a transform/positioning quirk on some mobile browser should never
// be able to leave multiple sheets simultaneously visible, which is exactly what real testing found.
function openSheet(id) {
  document.querySelectorAll('.sheet.open').forEach((s) => { s.classList.remove('open'); s.hidden = true; });
  lastFocusedBeforeSheet = document.activeElement;
  const sheet = document.getElementById(id);
  sheet.hidden = false;
  void sheet.offsetHeight; // force layout so un-hiding is registered before the slide-in transition starts
  sheet.classList.add('open');
  backdrop.classList.add('show');
  // Focus directly rather than inside requestAnimationFrame: rAF is suspended while the page is
  // hidden, so the callback silently never runs and focus never enters the dialog. Layout has
  // already been forced by the offsetHeight read above, so the element is focusable now.
  sheet.focus();
}
function closeSheets() {
  // Dismissing the confirmation any other way — Escape, the backdrop, the Close button — counts as
  // "no". Without this the awaiting caller would never resume, and confirmResolve would sit there
  // holding a promise nobody can settle.
  if (confirmResolve) {
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(false);
  }
  document.querySelectorAll('.sheet.open').forEach((s) => {
    s.classList.remove('open');
    setTimeout(() => { s.hidden = true; }, 300); // let the slide-down animation finish first
  });
  backdrop.classList.remove('show');
  if (lastFocusedBeforeSheet && typeof lastFocusedBeforeSheet.focus === 'function') {
    lastFocusedBeforeSheet.focus();
  }
  lastFocusedBeforeSheet = null;
  // An update that arrived while a sheet was open has been waiting for this moment.
  if (typeof applyUpdateIfIdle === 'function') setTimeout(applyUpdateIfIdle, 350);
}

// Every sheet declares aria-modal="true", which promises assistive technology that nothing behind
// it is reachable. Without a focus trap that promise is false: Tab walks straight out of the dialog
// onto the map controls and the bottom bar, and a screen-reader user ends up somewhere they cannot
// see, with no obvious way back. Measured before this: 8 focusable elements outside an open sheet
// were still reachable.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const sheet = document.querySelector('.sheet.open');
  if (!sheet) return;

  const focusables = [...sheet.querySelectorAll(
    'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.disabled && !el.hidden && !el.closest('[hidden]') && el.getBoundingClientRect().height > 0);
  if (!focusables.length) { e.preventDefault(); sheet.focus(); return; }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;

  // Wrap at both ends, and pull focus back in if it has escaped (or is still on the sheet itself).
  if (e.shiftKey && (active === first || active === sheet || !sheet.contains(active))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (active === last || !sheet.contains(active))) {
    e.preventDefault(); first.focus();
  }
});
backdrop.addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.sheet.open')) closeSheets();
});

// The dialog closes itself on either answer. It used to leave that to each caller, and two of them
// forgot — including SOS, where cancelling left the confirmation stuck on screen over the map.
// Callers that want to land on another sheet still just openSheet() afterwards; that supersedes
// this close, as it always did.
function settleConfirm(answer) {
  const resolve = confirmResolve;
  confirmResolve = null;
  closeSheets();
  if (resolve) resolve(answer);
}
document.getElementById('confirmCancelBtn').addEventListener('click', () => settleConfirm(false));
document.getElementById('confirmOkBtn').addEventListener('click', () => settleConfirm(true));

// ---------- Report sheet ----------
// Reached by tapping (or press-and-holding, for an area) the map directly — see the
// map pointerdown/click handlers above. There's no dedicated "Report" button: now that
// your live position is always visible as the blue dot, tapping it is just as fast.
let selectedRating = null;
let reportShape = 'spot'; // 'spot' | 'street'
let pendingStreetData = null; // { streetName, paths, lat, lng } once a street lookup succeeds
const submitReportBtn = document.getElementById('submitReport');
const streetLookupStatus = document.getElementById('streetLookupStatus');

function setReportShapeButtons(shape) {
  document.querySelectorAll('#reportShapeToggle .mode-btn').forEach((b) => {
    b.classList.toggle('selected', b.dataset.shape === shape);
  });
}

function openReportSheet() {
  // Gate here rather than at submit: being asked to sign in after writing a note would mean
  // losing it.
  if (!requireAccount('to add a rating to the map')) {
    pendingPoint = null;
    pendingRadius = null;
    return;
  }
  selectedRating = null;
  reportShape = 'spot';
  pendingStreetData = null;
  setReportShapeButtons('spot');
  streetLookupStatus.textContent = '';
  document.querySelectorAll('#reportSheet .rate-btn').forEach((b) => b.classList.remove('selected'));
  document.getElementById('reportNote').value = '';
  submitReportBtn.disabled = true;
  document.getElementById('reportCoords').textContent = pendingPoint
    ? pendingRadius
      ? `Marking an area ~${pendingRadius}m across, near ${pendingPoint.lat.toFixed(5)}, ${pendingPoint.lng.toFixed(5)}`
      : `${pendingPoint.lat.toFixed(5)}, ${pendingPoint.lng.toFixed(5)}`
    : '';
  // Head start: if they tap "Street" next, the network is usually already in the cache.
  if (pendingPoint) prefetchStreetNetwork(pendingPoint.lat, pendingPoint.lng);
  openSheet('reportSheet');
}

document.querySelectorAll('#reportShapeToggle .mode-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const shape = btn.dataset.shape;
    if (shape === 'spot') {
      reportShape = 'spot';
      pendingStreetData = null;
      streetLookupStatus.textContent = '';
      setReportShapeButtons('spot');
      return;
    }
    if (!pendingPoint) return;
    setLoadingStatus(streetLookupStatus, 'Loading nearby streets…');
    setReportShapeButtons('street');
    const graph = await fetchStreetNetwork(pendingPoint.lat, pendingPoint.lng);
    // pendingPoint may have changed (sheet closed/reopened) while this was in flight
    if (!document.getElementById('reportSheet').classList.contains('open')) return;
    if (!graph) {
      // Don't blame the location for what is usually an overloaded map server — that message sent
      // people hunting for a different spot when the real answer was "try again in a moment".
      streetLookupStatus.textContent = isOffline()
        ? "You are offline, so nearby streets cannot be loaded — that part needs a connection. You can still mark this as a spot, which works offline."
        : "The street map service isn't responding right now. Try again in a moment, or mark this as a spot instead.";
      reportShape = 'spot';
      setReportShapeButtons('spot');
      return;
    }
    reportShape = 'street';
    startStreetPicker(graph, pendingPoint.lat, pendingPoint.lng, null);
  });
});

// ---------- Street picking ----------
// Every walkable street in range is loaded into a graph, and the marked stretch is the route through
// it between the points you tap. Nothing is locked to one street, so a mark can turn corners and run
// through as many streets in a row as you like.
let trimState = null;
let trimEditingPinId = null; // set when re-picking an EXISTING owned street pin, instead of creating a new one

function currentStreetLabel() {
  return [...trimState.streetNames].join(' → ');
}

// Total metres of the chosen chain.
function trimPathLength() {
  const p = trimState.path;
  let d = 0;
  for (let i = 1; i < p.length; i++) d += haversine(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
  return Math.round(d);
}

function redrawTrimActive() {
  const { path, waypoints } = trimState;
  trimState.activeLine.setLatLngs(path);
  // A dot per waypoint, so it's obvious where each tap landed and what "Undo" will take back.
  trimState.dotLayer.clearLayers();
  waypoints.forEach((k, i) => {
    const n = trimState.graph.nodes.get(k);
    L.circleMarker([n.lat, n.lng], {
      radius: i === 0 ? 7 : 6,
      color: '#fff', weight: 2,
      fillColor: i === 0 ? token('--safe', '#4ade80') : token('--accent', '#8b7bff'),
      fillOpacity: 1, interactive: false,
    }).addTo(trimState.dotLayer);
  });

  const hint = document.getElementById('trimHint');
  const undoBtn = document.getElementById('trimUndoBtn');
  const doneBtn = document.getElementById('trimDoneBtn');
  const loading = trimState.widened ? '' : ' · loading more streets…';
  if (!waypoints.length) {
    hint.textContent = 'Tap where the stretch starts.' + loading;
  } else if (waypoints.length < 2) {
    hint.textContent = 'Now tap where the stretch ends. Keep tapping to run it through more streets.';
  } else {
    hint.textContent = `${trimPathLength()}m along ${currentStreetLabel()} — tap on to extend, or Use this stretch.`;
  }
  undoBtn.hidden = waypoints.length < 2;
  doneBtn.disabled = waypoints.length < 2;
}

// ---------- Street picker ----------
// Tap the start, tap the end, keep tapping. Each tap routes through the real street graph from the
// last point, so a chain can turn corners, run several streets in a row and double back — the maze
// behaviour that dragging two handles could never express.
// Pulls in the wider network behind the picker. The user can already be tapping while this runs;
// merging only adds streets, so nothing they have chosen is disturbed.
async function widenStreetNetwork(lat, lng) {
  const ways = await fetchOverpassWays(lat, lng, WIDE_RADIUS_M);
  if (!ways || !trimState) return;           // picker closed while we waited
  const added = mergeWaysIntoGraph(trimState.graph, ways);
  trimState.widened = true;
  if (added) redrawTrimActive();
}

function startStreetPicker(graph, seedLat, seedLng, existingPath) {
  closeSheets();
  const activeLine = L.polyline([], { color: token('--accent', '#8b7bff'), weight: 7, opacity: 0.95, interactive: false }).addTo(map);
  const dotLayer = L.layerGroup().addTo(map);

  trimState = {
    graph,
    waypoints: [],       // node keys the user tapped
    path: [],            // the full [lat,lng] chain between them
    streetNames: new Set(),
    activeLine,
    dotLayer,
  };

  // Re-editing an existing street mark: start from its current shape so nothing is lost, but let it
  // be rebuilt tap by tap like any other.
  if (existingPath && existingPath.length > 1) {
    const a = nearestGraphNode(graph, existingPath[0][0], existingPath[0][1], 60);
    const b = nearestGraphNode(graph, existingPath[existingPath.length - 1][0], existingPath[existingPath.length - 1][1], 60);
    if (a && b) { trimState.waypoints = [a]; addWaypoint(b); }
  }
  if (!trimState.waypoints.length && seedLat != null) {
    const seed = nearestGraphNode(graph, seedLat, seedLng, 80);
    if (seed) trimState.waypoints = [seed];
  }

  redrawTrimActive();
  if (trimState.path.length) map.fitBounds(activeLine.getBounds(), { padding: [70, 70] });
  document.getElementById('trimPanel').hidden = false;
  // Start widening now; the picker is already usable on the near network.
  if (seedLat != null) widenStreetNetwork(seedLat, seedLng);
}

// Routes from the last waypoint to `key` and appends that leg. Returns false if the streets don't
// connect, which is the one case worth telling the user about.
function addWaypoint(key) {
  const from = trimState.waypoints[trimState.waypoints.length - 1];
  if (!from) { trimState.waypoints = [key]; redrawTrimActive(); return true; }
  if (from === key) return true;

  const leg = shortestStreetPath(trimState.graph, from, key);
  if (!leg) return false;

  const pts = leg.keys.map((k) => { const n = trimState.graph.nodes.get(k); return [n.lat, n.lng]; });
  // Drop the first point: it's the one we're already standing on.
  trimState.path = trimState.path.length ? [...trimState.path, ...pts.slice(1)] : pts;
  trimState.waypoints.push(key);
  leg.names.forEach((n) => { if (n) trimState.streetNames.add(n); });   // unnamed connectors have no label
  trimState.legLengths = trimState.legLengths || [];
  trimState.legLengths.push(pts.length - 1);
  redrawTrimActive();
  return true;
}

// A tap while the picker is open: snap to the nearest street node and extend the chain.
// Snap a tap to a node, restricted to what is walkable from the current anchor once one exists.
// Reach is recomputed whenever the anchor changes or new streets have been merged in.
function snapToGraph(lat, lng) {
  const anchor = trimState.waypoints[trimState.waypoints.length - 1];
  if (anchor && (trimState.reachAnchor !== anchor || !trimState.reach || trimState.reachWays !== trimState.graph.wayIds.size)) {
    trimState.reach = reachableFrom(trimState.graph, anchor);
    trimState.reachAnchor = anchor;
    trimState.reachWays = trimState.graph.wayIds.size;
  }
  // Widen the snap radius when restricted, so a tap near a stranded fragment still finds the real
  // street behind it rather than giving up.
  return anchor
    ? nearestGraphNode(trimState.graph, lat, lng, 90, trimState.reach)
    : nearestGraphNode(trimState.graph, lat, lng, 60);
}

// Beyond this, fetching the whole corridor in one go is a big enough Overpass query to be worse
// than asking for a tap in between — which is what the message already suggests.
const MAX_EXTEND_RADIUS_M = 1200;

// Grow the network to cover the ground between the anchor and where the person just tapped.
//
// Fetching only around the tap is not enough, and that mistake is instructive: it leaves the middle
// of the walk undownloaded, so the two ends sit in separate islands and the router correctly
// reports no path between them. Measured on a 720m tap — the graph grew from 33 ways to 53 and the
// waypoint still would not attach. The corridor is what matters, so the request is centred on the
// midpoint with a radius that reaches both ends.
async function extendTowards(lat, lng) {
  const anchorKey = trimState.waypoints[trimState.waypoints.length - 1];
  const anchor = anchorKey ? trimState.graph.nodes.get(anchorKey) : null;
  const before = trimState.graph.wayIds.size;

  const ways = anchor
    ? await fetchOverpassWays(
        (anchor.lat + lat) / 2,
        (anchor.lng + lng) / 2,
        Math.min(MAX_EXTEND_RADIUS_M, haversine(anchor.lat, anchor.lng, lat, lng) / 2 + NEAR_RADIUS_M))
    : await fetchOverpassWays(lat, lng, NEAR_RADIUS_M);

  if (!trimState) return false;                    // picker closed while this was in flight
  if (!ways || !ways.length) return false;
  mergeWaysIntoGraph(trimState.graph, ways);
  return trimState.graph.wayIds.size > before;
}

async function handleStreetPick(lat, lng) {
  const hint = document.getElementById('trimHint');
  const said = hint ? hint.textContent : '';
  const whileLoading = async (work) => {
    if (hint) hint.textContent = 'Loading more streets…';
    const grew = await work();
    if (hint && trimState) hint.textContent = said;
    return grew;
  };

  // The picker opens on streets within 200m of where it started and widens to 500m — but always
  // around that starting point, never following you. Tracing a longer walk therefore taps past the
  // edge of what was ever downloaded, and the app said "no connected street there" about a road
  // that is perfectly connected in real life. Reported from an actual walk.
  let key = snapToGraph(lat, lng);
  if (!key && await whileLoading(() => extendTowards(lat, lng))) {
    if (!trimState) return;
    key = snapToGraph(lat, lng);                   // reach recomputes itself: wayIds.size changed
  }
  if (!trimState) return;

  if (!key) {
    showToast(trimState.waypoints.length
      ? 'No connected street there — tap somewhere along a road you could walk to.'
      : 'No street there — tap closer to a road.');
    return;
  }
  if (!trimState.waypoints.length) {
    trimState.waypoints = [key];
    redrawTrimActive();
    buzz();
    return;
  }
  if (!addWaypoint(key)) {
    // Snapped to a real street, but no route to it — usually because the ground in between is
    // still missing rather than because you cannot walk there. Fill the corridor and try again.
    const grew = await whileLoading(() => extendTowards(lat, lng));
    if (!trimState) return;
    const retry = grew ? snapToGraph(lat, lng) : null;
    if (!retry || !addWaypoint(retry)) {
      showToast("Can't reach that street on foot from here — try a point in between.");
      return;
    }
  }
  buzz();
}

function undoWaypoint() {
  if (!trimState || trimState.waypoints.length < 2) return;
  const drop = (trimState.legLengths || []).pop() || 0;
  trimState.waypoints.pop();
  trimState.path = trimState.path.slice(0, Math.max(0, trimState.path.length - drop));
  // Street names are rebuilt from what's left, so an undone detour stops being credited.
  trimState.streetNames = new Set();
  for (let i = 1; i < trimState.waypoints.length; i++) {
    const leg = shortestStreetPath(trimState.graph, trimState.waypoints[i - 1], trimState.waypoints[i]);
    if (leg) leg.names.forEach((n) => { if (n) trimState.streetNames.add(n); });   // unnamed connectors have no label
  }
  if (trimState.waypoints.length < 2) trimState.path = [];
  redrawTrimActive();
}

function endStreetTrim() {
  if (!trimState) return;
  map.removeLayer(trimState.activeLine);
  map.removeLayer(trimState.dotLayer);
  trimState = null;
  document.getElementById('trimPanel').hidden = true;
}

document.getElementById('trimCancelBtn').addEventListener('click', () => {
  endStreetTrim();
  if (trimEditingPinId) {
    const id = trimEditingPinId;
    trimEditingPinId = null;
    openPinSheet(id);
    return;
  }
  reportShape = 'spot';
  pendingStreetData = null;
  setReportShapeButtons('spot');
  streetLookupStatus.textContent = '';
  openSheet('reportSheet');
});

document.getElementById('trimUndoBtn').addEventListener('click', undoWaypoint);

document.getElementById('trimDoneBtn').addEventListener('click', () => {
  if (!trimState || trimState.path.length < 2) {
    showToast('Tap a start and an end point along the streets first.');
    return;
  }
  const streetName = currentStreetLabel();
  const trimmedPath = trimState.path;
  const meters = trimPathLength();
  const mid = trimmedPath[Math.floor(trimmedPath.length / 2)];

  if (trimEditingPinId) {
    const p = pins.find((x) => x.id === trimEditingPinId);
    endStreetTrim();
    trimEditingPinId = null;
    if (p) {
      p.paths = [trimmedPath];
      p.streetName = streetName;
      p.lat = mid[0];
      p.lng = mid[1];
      persistUpdate(p);
      renderPins();
      renderMyReports();
      openPinSheet(p.id);
    }
    showToast(`Updated — now marking ${meters}m of ${streetName}.`);
    buzz();
    return;
  }

  pendingStreetData = { streetName, paths: [trimmedPath], lat: mid[0], lng: mid[1] };
  endStreetTrim();
  streetLookupStatus.textContent = `✓ Marking ${meters}m of ${streetName}`;
  openSheet('reportSheet');
});

document.getElementById('pinRetraceBtn').addEventListener('click', async () => {
  const p = pins.find((x) => x.id === activePinId);
  if (!p || !p.paths) return;
  if (!requireAccount('to change a street you marked')) return;
  const pinId = p.id;
  closeSheets();
  showToast('Loading nearby streets…');
  const graph = await fetchStreetNetwork(p.lat, p.lng);
  if (!graph) {
    showToast(isOffline()
      ? "You are offline — the street map cannot be loaded. Your saved marks and the map itself still work."
      : "Couldn't look up nearby streets right now — try again in a moment.");
    openPinSheet(pinId);
    return;
  }
  trimEditingPinId = pinId;
  startStreetPicker(graph, p.lat, p.lng, p.paths[0]);
});

document.querySelectorAll('#reportSheet .rate-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedRating = btn.dataset.rating;
    document.querySelectorAll('#reportSheet .rate-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    submitReportBtn.disabled = false;
  });
});

submitReportBtn.addEventListener('click', () => {
  if (!pendingPoint || !selectedRating) return;
  if (!withinRatingRange(pendingPoint.lat, pendingPoint.lng)) {
    showToast('You can only rate spots within 1 km of your current location.');
    closeSheets();
    return;
  }
  const note = document.getElementById('reportNote').value.trim();
  const useStreet = reportShape === 'street' && pendingStreetData;
  const pin = {
    id: 'p-' + Math.random().toString(36).slice(2),
    lat: useStreet ? pendingStreetData.lat : pendingPoint.lat,
    lng: useStreet ? pendingStreetData.lng : pendingPoint.lng,
    radius: useStreet ? undefined : pendingRadius || undefined,
    paths: useStreet ? pendingStreetData.paths : undefined,
    streetName: useStreet ? pendingStreetData.streetName : undefined,
    safe: selectedRating === 'safe' ? 1 : 0,
    danger: selectedRating === 'danger' ? 1 : 0,
    notes: [], // a brand-new pin has no community notes yet
    createdAt: Date.now(),
    own: true,
    creatorRating: selectedRating,
    creatorNote: note,
    voters: [currentVoterId()],
  };
  pins.push(pin);
  persistCreate(pin);
  renderPins();
  pendingPoint = null;
  pendingRadius = null;
  pendingStreetData = null;
  closeSheets();
  buzz();
});

// ---------- Pin detail sheet ----------
let activePinId = null;
function openPinSheet(id) {
  activePinId = id;
  const p = pins.find((x) => x.id === id);
  if (!p) return;
  document.getElementById('pinTitle').textContent = p.streetName ? `🛣️ ${p.streetName}` : 'Community reports';
  const total = p.safe + p.danger;
  const ratio = total ? p.safe / total : 0.5;
  const band = ratingBand(ratio);
  const label = band === 'safe' ? 'Mostly reported safe' : band === 'danger' ? 'Mostly reported unsafe' : 'Mixed reports';
  document.getElementById('pinScore').textContent = label;
  document.getElementById('pinScore').style.color = ratingColor(ratio);
  document.getElementById('pinVotes').textContent = `🟢 ${p.safe} safe · 🔴 ${p.danger} unsafe`;
  const notesEl = document.getElementById('pinNotes');
  notesEl.innerHTML = '';
  const allNotes = p.notes.slice().reverse();
  if (p.creatorNote) allNotes.push({ text: p.creatorNote, rating: p.creatorRating });
  allNotes.forEach((n) => {
    const div = document.createElement('div');
    div.className = `pin-note ${n.rating}`;
    div.textContent = n.text;
    notesEl.appendChild(div);
  });
  const inRange = withinRatingRangeOfPin(p);
  const alreadyVoted = !!currentUser && (p.voters || []).includes(currentVoterId());
  // Left enabled while signed out on purpose — tapping is how you reach the sign-in prompt, and a
  // dead button explains nothing.
  document.querySelectorAll('#pinSheet [data-pin-rating]').forEach((b) => { b.disabled = !inRange || alreadyVoted; });
  document.getElementById('pinVoteHint').textContent = alreadyVoted
    ? "You've already added your rating here — one vote per person keeps this honest."
    : !currentUser
      ? 'Sign in to add your own rating.'
      : inRange
        ? ''
        : 'You need to be within 1 km of this spot to add your own rating.';
  document.getElementById('pinDeleteBtn').hidden = !p.own;
  document.getElementById('pinRetraceBtn').hidden = !(p.own && p.paths);
  openSheet('pinSheet');
}

document.getElementById('pinDeleteBtn').addEventListener('click', () => {
  deletePin(activePinId, { returnTo: null });
});

// The discoverable half of the fix above: a hold over an existing mark is the fast way to add
// another one, and this is the way you find without being told.
document.getElementById('pinAddHereBtn').addEventListener('click', () => {
  const p = pins.find((x) => x.id === activePinId);
  const at = lastTapLatLng || (p ? { lat: p.lat, lng: p.lng } : null);
  if (!at) return;
  if (!withinRatingRange(at.lat, at.lng)) {
    showToast('You can only rate spots within 1 km of your current location.');
    return;
  }
  pendingPoint = { lat: at.lat, lng: at.lng };
  pendingRadius = null;
  openReportSheet(); // itself gated on being signed in
});

document.querySelectorAll('#pinSheet [data-pin-rating]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const p = pins.find((x) => x.id === activePinId);
    if (!p) return;
    if (!requireAccount('to add your rating to this place')) return;
    if (!withinRatingRangeOfPin(p)) {
      showToast('You can only vote on spots within 1 km of your current location.');
      return;
    }
    const voterId = currentVoterId();
    if ((p.voters || []).includes(voterId)) {
      showToast("You've already added your rating here.");
      return;
    }
    if (btn.dataset.pinRating === 'safe') p.safe++;
    else p.danger++;
    p.voters = [...(p.voters || []), voterId];
    persistVote(p.id, btn.dataset.pinRating);
    renderPins();
    openPinSheet(activePinId);
  });
});

// ---------- Route planner ----------
async function geocode(query) {
  // Bias results toward whatever area the map is currently showing (soft bias, not a hard filter),
  // so short/ambiguous street names resolve locally instead of to some other country.
  const c = map.getCenter();
  const d = 0.6; // degrees ~ generous local box
  const viewbox = `${c.lng - d},${c.lat + d},${c.lng + d},${c.lat - d}`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&viewbox=${viewbox}&bounded=0&q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  // "We asked and there is no such place" and "we could not ask" are completely different things
  // to the person typing. Collapsing both into null made the app answer a dead geocoder with
  // "Couldn't find that address, try adding a city name" — sending someone off to correct an
  // address that was already correct, on the screen they are using to get home.
  if (!res) throw new Error('GEOCODER_UNREACHABLE');
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
}

// Turns whichever of the two failures happened into something the person can act on. Both end in
// "tap the pin", because that path needs no third-party service at all and always works.
async function geocodeForRoute(text, fieldLabel) {
  let point;
  try {
    point = await geocode(text);
  } catch (err) {
    if (err && err.message === 'GEOCODER_UNREACHABLE') {
      throw new Error(isOffline()
        ? `You are offline, so "${text}" cannot be looked up. Tap 📍 next to "${fieldLabel}" to pick the point on the map instead — that needs no connection.`
        : `Address lookup isn't responding right now, so "${text}" could not be checked. Tap 📍 next to "${fieldLabel}" to pick the point on the map instead — that needs no lookup at all.`);
    }
    throw err;
  }
  if (!point) {
    throw new Error(`Couldn't find "${text}". Try adding a city name, or tap 📍 next to "${fieldLabel}" to pick it on the map instead.`);
  }
  return point;
}

async function reverseGeocode(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17`;
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
  if (res) {
    const data = await res.json();
    if (data && data.display_name) {
      return data.display_name.split(',').slice(0, 3).join(',').trim();
    }
  }
  return `📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

// ---------- Pin-on-map start/end picking ----------
const routePins = { from: null, to: null }; // { lat, lng, label } | null

// The route sheet shows one step at a time. It used to show all of them at once — search form,
// three route cards, both start buttons and the after-the-walk feedback — which filled most of a
// phone with things that were irrelevant at that moment, and covered the map with the sheet exactly
// when someone was trying to compare three lines drawn on that map.
//
//   plan     where to
//   choose   the routes are on the map; this stays short so they can be seen
//   ready    one is chosen: start walking, or send a watch link
//   feedback only after a walk is finished — asking how a route felt while somebody is still
//            standing at the start of it was always the wrong moment to ask
// Tracked alongside the DOM state so the routeBtn handler below can tell "mid-plan, come back to
// where you were" apart from "a finished walk's feedback form, now abandoned" — activeRouteCoords
// alone cannot: it stays set through both.
let routeStep = 'plan';
function setRouteStep(step) {
  routeStep = step;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.hidden = !on; };
  show('routePlanBlock',   step === 'plan');
  show('routeResults',     step === 'choose' || step === 'ready');
  show('routeChosenBlock', step === 'ready');
  show('routeChangeBtn',   step === 'ready');
  show('routeNewSearchBtn', step === 'choose' || step === 'ready');
  show('routeFeedback',    step === 'feedback');
  show('routeStatus',      step !== 'feedback');
  document.getElementById('routeSheetTitle').textContent =
    step === 'feedback' ? 'How was that walk?'
    : step === 'ready'  ? 'Ready to go'
    : step === 'choose' ? 'Pick a route'
    : 'Find the safest route';
  // Only the chosen route stays listed once one is picked; the alternatives are still drawn on the
  // map, so nothing is lost by taking them out of the sheet.
  document.querySelectorAll('#routeResults .route-card').forEach((card) => {
    card.hidden = step === 'ready' && !card.classList.contains('selected');
  });
}
let pickingSide = null; // 'from' | 'to' | null
let startMarker = null;
let endMarker = null;

function endpointIcon(side) {
  return L.divIcon({
    className: '',
    html: `<div class="endpoint-marker ${side}">${side === 'from' ? 'A' : 'B'}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function placeEndpointMarker(side, lat, lng) {
  const onDrag = async (e) => {
    const ll = e.target.getLatLng();
    const input = document.getElementById(side === 'from' ? 'routeFrom' : 'routeTo');
    input.value = 'Locating address…';
    const label = await reverseGeocode(ll.lat, ll.lng);
    routePins[side] = { lat: ll.lat, lng: ll.lng, label };
    input.value = label;
  };
  if (side === 'from') {
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker([lat, lng], { icon: endpointIcon('from'), draggable: true }).addTo(map);
    startMarker.on('dragend', onDrag);
    startMarker.on('click', (e) => L.DomEvent.stopPropagation(e));
  } else {
    if (endMarker) map.removeLayer(endMarker);
    endMarker = L.marker([lat, lng], { icon: endpointIcon('to'), draggable: true }).addTo(map);
    endMarker.on('dragend', onDrag);
    endMarker.on('click', (e) => L.DomEvent.stopPropagation(e));
  }
}

function removeEndpointMarker(side) {
  if (side === 'from' && startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (side === 'to' && endMarker) { map.removeLayer(endMarker); endMarker = null; }
}

function setPickButtonState(side) {
  const btn = document.getElementById(side === 'from' ? 'pinFromBtn' : 'pinToBtn');
  const label = side === 'from' ? 'start point' : 'destination';
  btn.classList.remove('active', 'pinned');
  if (pickingSide === side) {
    btn.classList.add('active');
    btn.textContent = '✕';
    btn.setAttribute('aria-label', `Cancel picking ${label} on map`);
  } else if (routePins[side]) {
    btn.classList.add('pinned');
    btn.textContent = '✔';
    btn.setAttribute('aria-label', `Clear picked ${label}`);
  } else {
    btn.textContent = '📍';
    btn.setAttribute('aria-label', `Pick ${label} on map`);
  }
}

function showPickHint(side) {
  const hint = document.getElementById('mapHint');
  hint.textContent = side === 'from' ? 'Tap the map to set your starting point' : 'Tap the map to set your destination';
  hint.classList.remove('hidden');
}
function hidePickHint() {
  document.getElementById('mapHint').classList.add('hidden');
}
function cancelPicking() {
  if (!pickingSide) return;
  const side = pickingSide;
  pickingSide = null;
  hidePickHint();
  setPickButtonState(side);
}

async function handleMapPick(lat, lng) {
  const side = pickingSide;
  pickingSide = null;
  hidePickHint();
  placeEndpointMarker(side, lat, lng);
  const input = document.getElementById(side === 'from' ? 'routeFrom' : 'routeTo');
  input.value = 'Locating address…';
  const label = await reverseGeocode(lat, lng);
  routePins[side] = { lat, lng, label };
  input.value = label;
  openSheet('routeSheet');
  setPickButtonState(side);
}

function wirePinButton(side) {
  const btn = document.getElementById(side === 'from' ? 'pinFromBtn' : 'pinToBtn');
  const input = document.getElementById(side === 'from' ? 'routeFrom' : 'routeTo');
  btn.addEventListener('click', () => {
    if (pickingSide === side) {
      cancelPicking();
      return;
    }
    if (routePins[side]) {
      routePins[side] = null;
      input.value = '';
      removeEndpointMarker(side);
      setPickButtonState(side);
      input.focus();
      return;
    }
    if (pickingSide) cancelPicking();
    pickingSide = side;
    closeSheets();
    showPickHint(side);
    setPickButtonState(side);
  });

  // Typing in the field means the user wants a different point — silently drop the pin
  // instead of making them press the 📍 button first to "unlock" it.
  input.addEventListener('input', () => {
    if (routePins[side]) {
      routePins[side] = null;
      removeEndpointMarker(side);
      setPickButtonState(side);
    }
  });
}
wirePinButton('from');
wirePinButton('to');


let routeMode = 'pedestrian'; // 'pedestrian' | 'bicycle' — Valhalla costing model. No 'auto' (car) option by design.
document.querySelectorAll('#modeToggle .mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    routeMode = btn.dataset.mode;
    document.querySelectorAll('#modeToggle .mode-btn').forEach((b) => b.classList.toggle('selected', b === btn));
  });
});

document.getElementById('routeBtn').addEventListener('click', () => {
  setPickButtonState('from');
  setPickButtonState('to');
  // Reopening mid-plan should come back to where you were, not throw the search away — but with no
  // route in play it starts at the beginning. A route that ended in the feedback step is not "in
  // play" either: finishWalk() leaves activeRouteCoords set (submitting feedback needs it) and
  // opens the sheet on 'feedback', but most walks end without feedback ever being answered — it's
  // an optional form, not a required step. Without this, activeRouteCoords being merely truthy kept
  // the guard from firing, so the Route sheet reopened on the stale "How was that walk?" form for a
  // walk that was already over — a dead end, since routePlanBlock and routeNewSearchBtn are both
  // hidden on that step, so there was no visible way back to a fresh search.
  if (!activeRouteCoords || routeStep === 'feedback') {
    activeRouteCoords = null;
    setRouteStep('plan');
  }
  openSheet('routeSheet');
});

// ---------- Route feedback: rate how a route actually felt once you've used it ----------
let activeRouteCoords = null;
let selectedRouteFeedbackRating = null;
const routeFeedbackEl = document.getElementById('routeFeedback');
const submitRouteFeedbackBtn = document.getElementById('submitRouteFeedback');

document.querySelectorAll('#routeFeedback [data-route-rating]').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedRouteFeedbackRating = btn.dataset.routeRating;
    document.querySelectorAll('#routeFeedback [data-route-rating]').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    submitRouteFeedbackBtn.disabled = false;
  });
});

submitRouteFeedbackBtn.addEventListener('click', () => {
  if (!activeRouteCoords || !selectedRouteFeedbackRating) return;
  if (!requireAccount('to tell others how this route felt')) return;
  const note = document.getElementById('routeFeedbackNote').value.trim();
  const rating = selectedRouteFeedbackRating;
  const samples = 6;
  const step = Math.max(1, Math.floor(activeRouteCoords.length / samples));
  const touched = new Set();
  const voterId = currentVoterId();
  let affected = 0;
  let skippedAlreadyVoted = 0;
  // Every pin the route actually passed, whether or not this person could still vote on it. The
  // verdict is evidence about all of them, so it counts toward their authors' accuracy even where
  // the vote itself is a duplicate.
  const judged = new Set();
  for (let i = 0; i < activeRouteCoords.length; i += step) {
    const [lat, lng] = activeRouteCoords[i];
    const nearby = findNearbyPin(lat, lng, 60);
    if (nearby) {
      if (touched.has(nearby.id)) continue;
      touched.add(nearby.id);
      if (!nearby.own) judged.add(nearby.id);
      if ((nearby.voters || []).includes(voterId)) { skippedAlreadyVoted++; continue; }
      if (rating === 'safe') nearby.safe++; else nearby.danger++;
      if (note) nearby.notes.push({ text: note, rating });
      nearby.voters = [...(nearby.voters || []), voterId];
      persistVote(nearby.id, rating, note);
    } else {
      const routePin = {
        id: 'p-' + Math.random().toString(36).slice(2),
        lat,
        lng,
        safe: rating === 'safe' ? 1 : 0,
        danger: rating === 'danger' ? 1 : 0,
        notes: [],
        createdAt: Date.now(),
        own: true,
        source: 'route',
        creatorRating: rating,
        creatorNote: note,
        voters: [voterId],
      };
      pins.push(routePin);
      persistCreate(routePin);
    }
    affected++;
  }
  recordRouteJudgement([...judged], rating);
  renderPins();
  selectedRouteFeedbackRating = null;
  document.querySelectorAll('#routeFeedback [data-route-rating]').forEach((b) => b.classList.remove('selected'));
  document.getElementById('routeFeedbackNote').value = '';
  submitRouteFeedbackBtn.disabled = true;
  const skippedNote = skippedAlreadyVoted ? ` (${skippedAlreadyVoted} spot${skippedAlreadyVoted === 1 ? '' : 's'} skipped — already rated by you)` : '';
  showToast(`Thanks — added to ${affected} street rating${affected === 1 ? '' : 's'} along that route${skippedNote}.`);
  buzz();
  // Answered, so the walk is over: close rather than leaving a spent form on screen.
  closeSheets();
  activeRouteCoords = null;
  setRouteStep('plan');
});

document.getElementById('findRouteBtn').addEventListener('click', async () => {
  const status = document.getElementById('routeStatus');
  const resultsEl = document.getElementById('routeResults');
  resultsEl.innerHTML = '';
  routeLayer.clearLayers();
  setLoadingStatus(status, 'Locating your route…');
  activeRouteCoords = null;
  setRouteStep('plan');
  selectedRouteFeedbackRating = null;
  document.querySelectorAll('#routeFeedback [data-route-rating]').forEach((b) => b.classList.remove('selected'));
  document.getElementById('routeFeedbackNote').value = '';
  submitRouteFeedbackBtn.disabled = true;

  try {
    let fromPoint;
    if (routePins.from) {
      fromPoint = routePins.from;
    } else {
      const fromText = document.getElementById('routeFrom').value.trim();
      if (!fromText) {
        fromPoint = userLocation || (await locate(false));
        if (!fromPoint) throw new Error('Could not access your location. Tap 📍 next to "From" to pick a start point on the map instead.');
      } else {
        setLoadingStatus(status, 'Finding starting point…');
        fromPoint = await geocodeForRoute(fromText, "From");
      }
    }

    let toPoint;
    if (routePins.to) {
      toPoint = routePins.to;
    } else {
      const toText = document.getElementById('routeTo').value.trim();
      if (!toText) throw new Error('Enter a destination, or tap 📍 next to "To" to pick one on the map.');
      setLoadingStatus(status, 'Finding destination…');
      toPoint = await geocodeForRoute(toText, "To");
    }

    const modeLabel = routeMode === 'bicycle' ? 'biking' : 'walking';
    setLoadingStatus(status, `Comparing ${modeLabel} routes…`);
    const body = {
      locations: [
        { lat: fromPoint.lat, lon: fromPoint.lng },
        { lat: toPoint.lat, lon: toPoint.lng },
      ],
      costing: routeMode,
      alternates: 2,
    };
    const res = await fetchWithTimeout('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) throw new Error(
      isOffline()
        ? "You are offline, so a route cannot be worked out — that needs a connection. The map and your saved marks still work."
      : lastFetchFailure === 'timeout'
        ? "The routing service is taking too long to respond. Try again in a moment."
      : lastFetchFailure === 'http'
        ? "The routing service is having trouble right now. Try again in a moment."
        : "Couldn't reach the routing service. Check your connection and try again.");
    const data = await res.json();
    if (!data.trip) throw new Error(`No ${modeLabel} route found between those points.`);

    const trips = [data.trip, ...(data.alternates || []).map((a) => a.trip)];
    const scored = trips.map((trip) => {
      const coords = trip.legs.flatMap((leg) => decodePolyline(leg.shape, 6));
      const distanceKm = trip.summary.length;
      // Ratings AND events. Until this passed hazards, "find the safest route" ignored both the
      // police layer and every user incident report — the two freshest and most serious things the
      // app knows — so a route through a live cordon ranked identically to one avoiding it.
      return { coords, distanceKm, durationSec: trip.summary.time,
               ...routeSafetyScore(coords, distanceKm, pins, routeHazardList()) };
    });
    scored.sort((a, b) => b.score - a.score);

    // Evidence can sit on any route, not just the winning one — a warning on the SHORTEST route is
    // a reason to demote it even when the alternatives are unrated. Which claim that entitles the
    // app to make lives in geo.js, where it can be tested; see routeRankingClaim for the four
    // cases and why they are not interchangeable.
    const best = scored[0];
    const claim = routeRankingClaim(scored);
    const haveEvidence = claim.haveEvidence;
    const hazardOnBest = claim.kind === 'hazardOnRoute';
    const avoidsHazard = claim.kind === 'avoidsHazard';
    const topIsVouchedFor = claim.kind === 'safest';
    const topAvoidsWarnings = claim.kind === 'avoids';
    const topIsLeastBad = claim.kind === 'leastBad';
    const topReallyHasFewest = !!claim.hasFewest;

    if (!haveEvidence) scored.sort((a, b) => a.distanceKm - b.distanceKm);

    const flagged = scored.reduce((n, r) => n + (r.dangerPins ? 1 : 0), 0);
    // Events first, and worded so nobody mistakes a stranger's report for a police one. A hazard
    // still on the recommended route is the one thing that must be said before anything else,
    // because every other sentence here is a reassurance by comparison.
    status.textContent = hazardOnBest
      ? (claim.isUnavoidable
          ? `Every route passes something reported recently. ${hazardSentence(claim.worstHazard)} There is no way round it from here.`
          : `${hazardSentence(claim.worstHazard)} It is on the recommended route — check the others below.`)
      : avoidsHazard
        ? 'Ranked to go around something reported recently. Tap the ⚠ marks to see what.'
      : topIsVouchedFor
      ? `${scored.length} route${scored.length > 1 ? 's' : ''} compared using ${pins.length} community report${pins.length === 1 ? '' : 's'}.`
      : topAvoidsWarnings
        ? `Ranked to avoid ${flagged} route${flagged === 1 ? '' : 's'} with reports of trouble. Nobody has rated the recommended one yet.`
        : topIsLeastBad
          ? `Every route here has somewhere reported unsafe on it. This one ranks best on the reports available${topReallyHasFewest ? `, with the fewest — ${best.dangerPins} spot${best.dangerPins === 1 ? '' : 's'}` : ''}.`
        : pins.length
          ? 'No reports along these routes yet — they are ranked by distance only.'
          : 'Nobody has rated streets around here yet, so these routes are ranked by distance only.';

    const entries = [];
    scored.forEach((r, rank) => {
      const isBest = rank === 0;
      const poly = L.polyline(r.coords, { color: token('--text-dim', '#5b5d94'), weight: 4, opacity: 0.55 }).addTo(routeLayer);

      const mins = Math.round(r.durationSec / 60);
      const km = r.distanceKm.toFixed(2);
      // "SAFEST" is a claim about evidence. Without it, the honest label is "shortest".
      const badge = !isBest ? ''
        : topIsVouchedFor ? '<span class="route-badge">SAFEST</span>'
        : topAvoidsWarnings ? '<span class="route-badge route-badge-plain">AVOIDS FLAGGED STREETS</span>'
        : topIsLeastBad ? `<span class="route-badge route-badge-plain">${topReallyHasFewest ? 'FEWEST WARNINGS' : 'RANKED BY REPORTS'}</span>`
        : '<span class="route-badge route-badge-plain">SHORTEST</span>';
      const reported = r.pinsNearby
        ? `${r.pinsNearby} report${r.pinsNearby === 1 ? '' : 's'} near ${Math.round(r.coverage * 100)}% of it`
        : 'no reports along it yet';
      const warn = r.dangerPins
        ? `<div class="route-warn">⚠ ${r.dangerPins} spot${r.dangerPins === 1 ? '' : 's'} on this route reported unsafe</div>`
        : '';
      const card = document.createElement('div');
      card.className = 'route-card';
      card.innerHTML = `
        <div class="route-card-top">
          <span>Route ${rank + 1}</span>
          ${badge}
        </div>
        <div class="route-meta">${km} km · ~${mins} min ${modeLabel} · ${reported}</div>
        ${warn}
      `;
      const statusLabel = document.createElement('div');
      statusLabel.className = 'route-status-label';
      statusLabel.textContent = 'Tap to show this route on the map';
      card.appendChild(statusLabel);
      resultsEl.appendChild(card);

      entries.push({ poly, card, statusLabel, rank, coords: r.coords });
    });

    function selectRoute(rank, { fitView = true, keepSheetOpen = false } = {}) {
      entries.forEach((e) => {
        const active = e.rank === rank;
        e.poly.setStyle({
          // Purple, not green — a route line needs to read as "directions," clearly distinct from
          // the green/yellow/red used for street safety ratings, or the two get visually confused.
          color: active ? token('--accent', '#8b7bff') : token('--text-dim', '#5b5d94'),
          weight: active ? 6 : 4,
          opacity: active ? 0.95 : 0.55,
        });
        if (active) e.poly.bringToFront();
        e.card.classList.toggle('selected', active);
        e.statusLabel.textContent = active ? 'Showing on map ✓' : 'Tap to show this route on the map';
      });
      activeRouteCoords = entries[rank].coords;
      // Choosing a route moves the flow on rather than piling the next options on top of the old
      // ones. Feedback is NOT offered here any more — that belongs after the walk.
      setRouteStep('ready');
      if (fitView) {
        if (!keepSheetOpen) closeSheets();
        map.fitBounds(entries[rank].poly.getBounds(), { padding: [40, 40] });
      }
    }

    entries.forEach((e) => {
      e.card.addEventListener('click', () => selectRoute(e.rank));
      e.poly.on('click', () => selectRoute(e.rank, { keepSheetOpen: true }));
    });

    // The first route is drawn as the active one so the map is not ambiguous, but the flow stops
    // here: choosing is the person's job, and auto-advancing to "ready" would skip the step they
    // asked for. selectRoute moves to 'ready', so this puts it back.
    if (entries.length) {
      selectRoute(0, { fitView: true, keepSheetOpen: true });
      setRouteStep('choose');
    }
  } catch (err) {
    status.textContent = typeof err.message === 'string' && err.message
      ? err.message
      : 'Something went wrong finding that route. Check your connection and try again.';
  }
});

// ---------- SOS ----------
// A web page can never silently place a call — it always requires the user's own confirmation.
// So the flow here is deliberately just two steps: confirm, then call your one emergency contact.
// A tel: URL must not contain spaces or punctuation. Someone will type "+47 123 45 678" — and the
// moment that fails is the moment they least need it to.
function normalisePhone(raw) {
  const trimmed = String(raw || '').trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  return plus + trimmed.replace(/[^0-9]/g, '');
}
function isUsablePhone(raw) {
  return normalisePhone(raw).replace(/\D/g, '').length >= 5;
}

document.getElementById('sosBtn').addEventListener('click', async () => {
  cancelPicking();
  const contact = contacts[0];
  if (!contact || !contact.phone) {
    showToast('Add your emergency contact in My Page first, so SOS knows who to call.');
    openMyPage();
    return;
  }
  const ok = await showConfirm(`Call ${contact.name} now?`, { okLabel: 'Call now', title: 'Are you sure?' });
  if (!ok) return;
  buzz();
  placeCall(normalisePhone(contact.phone), contact.name);

  // The commonest way SOS fails is not a wrong number — it is that they do not answer. Coming back
  // to a screen with no next step, at that particular moment, is the worst version of this app.
  // So the others are offered here, one tap each, already on screen when the call ends.
  if (contacts.length > 1) offerBackupContacts(0);
});

// Shown after a call is placed, so it is waiting when they come back to the app rather than needing
// to be found. Not a countdown and not automatic: nothing here dials on its own, ever.
function offerBackupContacts(justCalled) {
  const rest = contacts.filter((_, i) => i !== justCalled);
  if (!rest.length) return;
  const list = document.getElementById('sosNextList');
  list.innerHTML = '';
  rest.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'btn btn-danger btn-block';
    btn.textContent = `Call ${c.name}`;
    btn.addEventListener('click', () => {
      buzz();
      placeCall(normalisePhone(c.phone), c.name);
      offerBackupContacts(contacts.indexOf(c));
    });
    list.appendChild(btn);
  });
  openSheet('sosNextSheet');
}

// Dialling via a real anchor click rather than location.href, for the same reason this app had to
// stop using confirm(): a standalone PWA does not reliably honour a scripted navigation to a
// tel: URL, and it fails silently when it doesn't. A synthesised click on an <a href="tel:"> is
// what browsers actually expect. If nothing happens within a moment, say so and show the number,
// so the person can dial it themselves instead of staring at a screen that did nothing.
function placeCall(number, name) {
  const link = document.createElement('a');
  link.href = `tel:${number}`;
  link.style.display = 'none';
  document.body.appendChild(link);
  let launched = false;
  const noteLaunch = () => { launched = true; };
  window.addEventListener('blur', noteLaunch, { once: true });
  document.addEventListener('visibilitychange', noteLaunch, { once: true });

  link.click();
  link.remove();

  setTimeout(() => {
    window.removeEventListener('blur', noteLaunch);
    document.removeEventListener('visibilitychange', noteLaunch);
    if (!launched) {
      showToast(`Couldn't start the call. Dial ${name} on ${number}.`, 12000);
    }
  }, 1500);
}

// ---------- Settings / contacts ----------
const DARK_MAP_KEY = 'safewalk_dark_map';
function applyDarkMapPref() {
  const enabled = localStorage.getItem(DARK_MAP_KEY) !== 'false'; // defaults on, matching how the map already looked
  document.getElementById('map').classList.toggle('dark-tiles', enabled);
  document.getElementById('darkMapToggle').checked = enabled;
}
document.getElementById('darkMapToggle').addEventListener('change', (e) => {
  localStorage.setItem(DARK_MAP_KEY, e.target.checked ? 'true' : 'false');
  document.getElementById('map').classList.toggle('dark-tiles', e.target.checked);
});

// ---------- Themes ----------
const THEME_KEY = 'safewalk_theme';
const THEMES = [
  { id: 'midnight', name: 'Midnight', hint: 'The original deep blue' },
  { id: 'blossom', name: 'Blossom', hint: 'Soft pastels, light' },
  { id: 'dusk', name: 'Dusk', hint: 'Pastels for night walking' },
  { id: 'contrast', name: 'Contrast', hint: 'Maximum legibility' },
];

function currentTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  return THEMES.some((t) => t.id === saved) ? saved : 'midnight';
}

function applyTheme(id, { followMapDefault = false } = {}) {
  document.documentElement.setAttribute('data-theme', id);
  localStorage.setItem(THEME_KEY, id);
  // Picking a theme sets the map to match it — a light theme with an inverted black map looks
  // broken. The dark-map switch is still there to override afterwards if you disagree.
  if (followMapDefault) {
    const wantsDark = getComputedStyle(document.documentElement).getPropertyValue('--invert-tiles').trim() !== '0';
    localStorage.setItem(DARK_MAP_KEY, wantsDark ? 'true' : 'false');
  }
  applyDarkMapPref();
  // The accent override sits on top of whichever preset was just applied, so it must be re-set
  // after data-theme changes or the previous theme's accent would win.
  applyAccentOverride();
  renderThemePicker();
  // Map shapes are drawn with resolved colours, not CSS, so they have to be redrawn to pick up
  // the new palette. Without this the sheets restyle instantly and the map stays on the old theme.
  renderPins();
  refreshMapChrome();
}


// ---------- Custom accent colour ----------
// An override that sits on top of whichever preset is selected, rather than a fifth theme: people
// want "Dusk, but teal", not a separate palette to maintain.
//
// Whatever colour is chosen, the label on top of it must stay readable. adjustForContrast nudges
// the lightness the smallest distance that clears WCAG AA, keeping the hue — a sweep of 540
// colours found 12 mid-tones where neither the dark nor the light ink reaches 4.5:1 on the raw
// choice. The rating colours are never touched: red/amber/green mean something, and letting a
// preference repaint them would break the one part of the map that has to be unambiguous.
const ACCENT_KEY = 'safewalk_accent';

function storedAccent() {
  const v = localStorage.getItem(ACCENT_KEY);
  return v && hexToRgb(v) ? v : null;
}

function applyAccentOverride() {
  const root = document.documentElement;
  const chosen = storedAccent();
  const note = document.getElementById('accentNote');
  const reset = document.getElementById('accentReset');
  const picker = document.getElementById('accentPicker');

  if (!chosen) {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-ink');
    if (reset) reset.hidden = true;
    if (note) note.textContent = 'Using this theme’s own accent.';
    if (picker) picker.value = rgbStringToHex(getComputedStyle(root).getPropertyValue('--accent').trim());
    return;
  }

  const used = adjustForContrast(chosen);
  root.style.setProperty('--accent', used);
  root.style.setProperty('--accent-ink', pickReadableInk(used));
  if (reset) reset.hidden = false;
  if (picker) picker.value = chosen;
  if (note) {
    const ratio = contrastRatio(pickReadableInk(used), used).toFixed(1);
    note.textContent = used.toLowerCase() === chosen.toLowerCase()
      ? `Your accent, with ${ratio}:1 label contrast.`
      : `Nudged to ${used} so text on it stays readable (${ratio}:1). Rating colours are unchanged.`;
  }
}

// <input type="color"> only accepts #rrggbb, and getComputedStyle may hand back either form.
function rgbStringToHex(v) {
  if (!v) return '#8b7bff';
  if (v.startsWith('#')) return v.length === 4 ? '#' + v.slice(1).split('').map((c) => c + c).join('') : v;
  const m = v.match(/(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) return '#8b7bff';
  return '#' + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
}

document.getElementById('accentPicker').addEventListener('input', (e) => {
  localStorage.setItem(ACCENT_KEY, e.target.value);
  applyAccentOverride();
  renderPins();
  refreshMapChrome();
});

document.getElementById('accentReset').addEventListener('click', () => {
  localStorage.removeItem(ACCENT_KEY);
  applyAccentOverride();
  renderPins();
  refreshMapChrome();
  buzz();
});

function renderThemePicker() {
  const wrap = document.getElementById('themePicker');
  if (!wrap) return;
  const active = currentTheme();
  wrap.innerHTML = '';
  THEMES.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-chip' + (t.id === active ? ' selected' : '');
    btn.setAttribute('aria-pressed', String(t.id === active));
    btn.innerHTML = `
      <span class="theme-swatch theme-swatch-${t.id}" aria-hidden="true">
        <i class="sw-bg"></i><i class="sw-accent"></i><i class="sw-safe"></i><i class="sw-danger"></i>
      </span>
      <span class="theme-name">${t.name}</span>
      <span class="theme-hint">${t.hint}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(t.id, { followMapDefault: true });
      buzz();
    });
    wrap.appendChild(btn);
  });
}

// Reads a theme token as a real colour value, for the parts of the map drawn by Leaflet rather
// than styled by CSS.
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// The map layers that aren't pins: your location dot, the 1 km rating boundary, and the lit-street
// overlay. Restyled in place rather than rebuilt, so switching theme doesn't re-request NVDB or
// drop your position fix.
function refreshMapChrome() {
  if (userAccuracyCircle) {
    userAccuracyCircle.setStyle({ color: token('--you', '#4a9eff'), fillColor: token('--you', '#4a9eff') });
  }
  if (userRangeCircle) userRangeCircle.setStyle({ color: token('--text-dim', '#8b93a8') });
  lightingLayer.eachLayer((l) => {
    if (l.setStyle) l.setStyle({ color: token('--mixed', '#facc15') });
  });
  if (trimState) {
    trimState.activeLine.setStyle({ color: token('--accent', '#8b7bff') });
    redrawTrimActive();
  }
}

function openMyPage() {
  cancelPicking();
  renderMenuHints();
  openSheet('settingsSheet');
}
// Reachable from the bottom bar, where a thumb actually lands on a phone.
document.getElementById('myPageBtn').addEventListener('click', openMyPage);

// My Page is a hub of four rooms. Each renders itself on the way in, rather than the hub rendering
// all four every time it opens: only one is ever on screen, and the standing lookup behind Profile
// is a network round-trip nobody asked for when they came to change the theme.
function openProfile() { renderAccountState(); refreshStanding(); resetPasswordForm(); openSheet('profileSheet'); }
function openThemeSettings() { applyDarkMapPref(); renderThemePicker(); openSheet('themeSheet'); }
function openContactSettings() { renderContacts(); openSheet('contactSheet'); }
function openMyReports() { renderMyReports(); openSheet('myReportsSheet'); }

document.getElementById('menuProfileBtn').addEventListener('click', openProfile);
document.getElementById('menuThemeBtn').addEventListener('click', openThemeSettings);
document.getElementById('menuContactBtn').addEventListener('click', openContactSettings);
document.getElementById('menuReportsBtn').addEventListener('click', openMyReports);
// Back goes up one level; Close leaves for the map. Only one sheet is ever open at a time, so
// without a way back, checking your marks and then your contact meant reopening My Page from the
// bottom bar in between.
document.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', openMyPage));

// What is behind each door, said on the door. The emergency-contact line is the one that earns
// this: "Not set yet" on the hub is the difference between finding out now and finding out at the
// moment you press SOS.
function renderMenuHints() {
  document.getElementById('menuProfileHint').textContent = currentUser
    ? (currentUser.email || 'Signed in')
    : 'Not signed in';

  const c = contacts[0];
  document.getElementById('menuContactHint').textContent = c && c.phone
    ? `SOS calls ${c.name || c.phone}`
    : 'Not set yet — SOS has nobody to call';

  const mine = pins.filter((p) => p.own).length;
  const waiting = typeof outboxForMe === 'function' ? outboxForMe().length : 0;
  document.getElementById('menuReportsHint').textContent = waiting
    ? `${mine} of yours — ${waiting} waiting to upload`
    : mine
      ? `${mine} rating${mine === 1 ? '' : 's'} of yours`
      : 'Nothing rated yet';

  const theme = THEMES.find((t) => t.id === currentTheme());
  document.getElementById('menuThemeHint').textContent = theme ? theme.name : 'Colours and the map';
}

// Only one emergency contact — SOS calls them directly, so there's no list to manage, just
// "who is it" and a way to replace them.
// Up to three, in order, and the order is the whole point. SOS has always dialled one person, which
// is right — a picker is the last thing anyone wants mid-emergency — but it left the commonest
// failure unanswered: they do not pick up. The first contact is still who SOS calls with no choice
// to make; the others exist so that "no answer" is not the end of it.
const MAX_CONTACTS = 3;

function renderContacts() {
  const list = document.getElementById('contactList');
  const showFormBtn = document.getElementById('showContactFormBtn');
  list.innerHTML = '';
  showFormBtn.hidden = contacts.length >= MAX_CONTACTS;
  showFormBtn.textContent = contacts.length ? '+ Add another' : '+ Add emergency contact';

  contacts.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'contact-row';

    // textContent, not innerHTML: this names the person the SOS button dials, and a name containing
    // <, & or " would otherwise be mangled or swallowed by the HTML parser. The data is
    // self-authored and local-only, so this is about the name being displayed correctly far more
    // than about scripting — but there is no reason to build it as HTML in the first place.
    const who = document.createElement('span');
    who.className = 'contact-who';
    who.textContent = `${c.name} · ${c.phone}`;
    row.appendChild(who);

    if (i === 0) {
      const tag = document.createElement('span');
      tag.className = 'contact-primary';
      tag.textContent = 'SOS calls this one';
      row.appendChild(tag);
    } else {
      const up = document.createElement('button');
      up.textContent = 'Make first';
      up.addEventListener('click', () => {
        contacts = [c, ...contacts.filter((x) => x !== c)];
        saveContacts(contacts);
        renderContacts();
        renderMenuHints();
      });
      row.appendChild(up);
    }

    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => {
      contacts = contacts.filter((x) => x !== c);
      saveContacts(contacts);
      renderContacts();
      renderMenuHints();
    });
    row.appendChild(rm);
    list.appendChild(row);
  });
}

document.getElementById('showContactFormBtn').addEventListener('click', () => {
  document.getElementById('contactForm').hidden = false;
  document.getElementById('showContactFormBtn').hidden = true;
});

document.getElementById('cancelContactBtn').addEventListener('click', () => {
  document.getElementById('contactForm').hidden = true;
  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '';
  renderContacts();
});

document.getElementById('addContactBtn').addEventListener('click', () => {
  const name = document.getElementById('contactName').value.trim();
  const phone = document.getElementById('contactPhone').value.trim();
  if (!name || !phone) {
    showToast('Enter a name and phone number.');
    return;
  }
  // Catch an unusable number now, at a calm moment, rather than letting someone discover it while
  // frightened and pressing SOS. Deliberately loose — international formats vary wildly and a
  // strict pattern would reject real numbers — but "asdf" should not be accepted.
  if (!isUsablePhone(phone)) {
    showToast("That doesn't look like a phone number SOS could dial. Include the digits, and the country code if you have it.");
    return;
  }
  // Stored already normalised, so the dial string is correct even if this record predates SOS.
  const next = normalisePhone(phone);
  if (contacts.some((c) => normalisePhone(c.phone) === next)) {
    showToast('That number is already one of your contacts.');
    return;
  }
  // Appended, never replacing: the first contact is the one SOS dials, and quietly demoting the
  // person somebody chose for that is the last thing this screen should do behind their back.
  contacts = [...contacts, { name, phone: next }].slice(0, MAX_CONTACTS);
  saveContacts(contacts);
  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '';
  document.getElementById('contactForm').hidden = true;
  renderContacts();
  renderMenuHints();
});

document.getElementById('clearDataBtn').addEventListener('click', async () => {
  // Deliberately scoped to this device. Your ratings belong to your account and stay there — the
  // place to remove those is My marks, one at a time, so this button can't quietly wipe the map.
  const ok = await showConfirm(
    'Clear your emergency contact and app settings on this device? Your ratings stay on your account.',
    { okLabel: 'Clear device data', title: 'Clear data on this device?' }
  );
  // showConfirm closes whatever was open to ask, so "no" has to put Profile back rather than
  // leaving you on the map wondering whether it went ahead.
  if (!ok) { openProfile(); return; }
  localStorage.removeItem(CONTACTS_KEY);
  localStorage.removeItem(ONBOARDED_KEY);
  localStorage.removeItem(DARK_MAP_KEY);
  localStorage.removeItem(THEME_KEY);
  localStorage.removeItem(ACCENT_KEY);
  location.reload();
});

// ---------- My reports & marks (view / edit / delete what you've added) ----------
// Opened from the My Page hub — see openMyReports().

function relativeDate(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderMyReports() {
  const list = document.getElementById('myReportsList');
  list.innerHTML = '';
  const mine = pins.filter((p) => p.own).sort((a, b) => b.createdAt - a.createdAt);
  if (!mine.length) {
    // "You haven't added any ratings yet" is a claim about the person. Only make it when the fetch
    // that would have found them actually succeeded.
    list.innerHTML = !currentUser
      ? '<p class="sheet-sub">Sign in to start adding ratings. They’ll follow your account, so they show up on every device you use.</p>'
      : myHistoryIncomplete
        ? '<p class="sheet-sub">Couldn’t load your ratings just now — this list may be incomplete. Reopen it once you have a connection.</p>'
        : '<p class="sheet-sub">You haven’t added any ratings yet — tap the map to rate a spot, or press and hold to mark an area.</p>';
    return;
  }
  mine.forEach((p) => {
    const total = p.safe + p.danger;
    const ratio = total ? p.safe / total : 0.5;
    const color = ratingColor(ratio);
    const row = document.createElement('div');
    row.className = 'report-row';
    row.innerHTML = `
      <div class="report-row-top">
        <span class="report-swatch" style="background:${color}"></span>
        <span>${p.creatorRating === 'safe' ? 'Marked Safe' : 'Marked Unsafe'}</span>
        ${p.radius ? '<span class="report-tag">Area</span>' : ''}
        ${p.paths ? '<span class="report-tag">🛣️ Street</span>' : ''}
        ${p.source === 'route' ? '<span class="report-tag">🧭 Route</span>' : ''}
        ${p.pending ? '<span class="report-tag report-tag-pending">⏳ Waiting to upload</span>' : ''}
        <span class="report-date">${relativeDate(p.createdAt)}</span>
      </div>
      <div class="report-note">${p.streetName ? p.streetName + (p.creatorNote ? ' — ' + p.creatorNote : '') : (p.creatorNote ? p.creatorNote : 'No note added')}</div>
    `;
    const actions = document.createElement('div');
    actions.className = 'report-row-actions';
    const showBtn = document.createElement('button');
    showBtn.className = 'btn btn-secondary';
    showBtn.textContent = 'Show on map';
    showBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSheets();
      if (p.paths) map.fitBounds(L.polyline(p.paths.flat()).getBounds(), { padding: [40, 40] });
      else if (p.radius) map.fitBounds(L.circle([p.lat, p.lng], { radius: p.radius }).getBounds(), { padding: [40, 40] });
      else map.setView([p.lat, p.lng], 17);
    });
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditPinSheet(p.id);
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deletePin(p.id);
    });
    actions.appendChild(showBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);
    list.appendChild(row);
  });
}

// `returnTo`: which sheet to land back on afterward — 'myReportsSheet' when deleting from that list
// or its edit screen, or null when deleting directly off the map (no reason to detour through My Page).
async function deletePin(id, { returnTo = 'myReportsSheet' } = {}) {
  const ok = await showConfirm('Delete this report? This cannot be undone.', { okLabel: 'Delete', title: 'Delete this report?' });
  if (!ok) { if (returnTo) openSheet(returnTo); else closeSheets(); return; }
  pins = pins.filter((x) => x.id !== id);
  persistDelete(id);
  renderPins();
  renderMyReports();
  if (returnTo) openSheet(returnTo); else closeSheets();
  showToast('Report deleted.');
  buzz();
}

let editingPinId = null;
let editingRating = null;

function openEditPinSheet(id) {
  const p = pins.find((x) => x.id === id);
  if (!p) return;
  editingPinId = id;
  editingRating = p.creatorRating;
  document.querySelectorAll('#editPinSheet [data-edit-rating]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.editRating === editingRating);
  });
  document.getElementById('editPinNote').value = p.creatorNote || '';
  document.getElementById('editPinCoords').textContent = p.paths
    ? `🛣️ Whole street — ${p.streetName}`
    : p.radius
      ? `Area mark, ~${p.radius}m across — ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
      : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
  openSheet('editPinSheet');
}

document.querySelectorAll('#editPinSheet [data-edit-rating]').forEach((btn) => {
  btn.addEventListener('click', () => {
    editingRating = btn.dataset.editRating;
    document.querySelectorAll('#editPinSheet [data-edit-rating]').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

document.getElementById('saveEditPin').addEventListener('click', () => {
  const p = pins.find((x) => x.id === editingPinId);
  if (!p) return;
  if (p.creatorRating === 'safe') p.safe = Math.max(0, p.safe - 1);
  else if (p.creatorRating === 'danger') p.danger = Math.max(0, p.danger - 1);
  if (editingRating === 'safe') p.safe++;
  else p.danger++;
  p.creatorRating = editingRating;
  p.creatorNote = document.getElementById('editPinNote').value.trim();
  persistUpdate(p);
  renderPins();
  renderMyReports();
  closeSheets();
  showToast('Report updated.');
  buzz();
});

document.getElementById('deleteEditPin').addEventListener('click', () => {
  deletePin(editingPinId);
});


// ---------- "Near me": the map, in words ----------
// The map is the whole product and it had no non-visual equivalent, so "which streets near me are
// marked unsafe" could only be answered by looking. That excludes screen-reader users entirely,
// and it is also just worse for anyone walking at night who would rather glance once than study a
// map. This lists what is around you as sentences, nearest first, with a direction you can act on.
//
// Unsafe places are listed before safe ones at the same distance. If someone opens this while
// walking, the warning is what they need first; a reassurance can wait a line.
const NEAR_ME_RADIUS_M = 600;

function nearMeEntries() {
  if (!userLocation) return null;
  const { lat, lng } = userLocation;

  const fromPins = pins.map((p) => {
    // Measure to the nearest point ON a marked street rather than its stored midpoint, so a street
    // you are standing on does not read as 200m away — and aim the compass at that same point, so
    // the distance and the direction are describing the same place. They used not to: on a
    // selection chaining several streets it named the wrong direction in 80 of 94 real Oslo cases.
    const near = p.paths ? nearestPointOnPaths(lat, lng, p.paths) : null;
    const aim = near || { lat: p.lat, lng: p.lng };
    const dist = near ? near.dist : haversine(lat, lng, p.lat, p.lng);
    const total = p.safe + p.danger;
    const ratio = total ? p.safe / total : 0.5;
    const band = ratingBand(ratio);
    return {
      kind: 'pin', dist, band,
      name: p.streetName || (p.radius ? 'A marked area' : 'A marked spot'),
      detail: `${p.safe} safe, ${p.danger} unsafe`,
      bearing: bearingDegrees(lat, lng, aim.lat, aim.lng),
      note: p.creatorNote || (p.notes && p.notes.length ? p.notes[0].text : ''),
    };
  });

  const fromPolice = policeEvents.map((e) => ({
    kind: 'police',
    dist: Math.max(0, haversine(lat, lng, e.lat, e.lng) - (e.radius_m || 0)),
    band: 'danger',
    name: `Police: ${describeCategory(e.category)}`,
    detail: e.is_active ? 'ongoing' : 'reported earlier',
    bearing: bearingDegrees(lat, lng, e.lat, e.lng),
    note: e.area ? `Somewhere around ${e.area}` : '',
  }));

  const rank = { danger: 0, mixed: 1, safe: 2 };
  return [...fromPins, ...fromPolice]
    .filter((e) => e.dist <= NEAR_ME_RADIUS_M)
    .sort((a, b) => (rank[a.band] - rank[b.band]) || (a.dist - b.dist));
}

function renderNearMe() {
  const list = document.getElementById('nearMeList');
  const summary = document.getElementById('nearMeSummary');
  list.innerHTML = '';

  const entries = nearMeEntries();
  if (!entries) {
    summary.textContent = 'Your location is not available yet, so there is nothing to measure from.';
    return;
  }
  if (!entries.length) {
    summary.textContent = `Nothing has been reported within ${NEAR_ME_RADIUS_M} m of you. That means nobody has said anything about these streets — not that they are known to be safe.`;
    return;
  }

  const unsafe = entries.filter((e) => e.band === 'danger').length;
  summary.textContent = unsafe
    ? `${entries.length} report${entries.length === 1 ? '' : 's'} within ${NEAR_ME_RADIUS_M} m, ${unsafe} of them flagged. Flagged first, then nearest.`
    : `${entries.length} report${entries.length === 1 ? '' : 's'} within ${NEAR_ME_RADIUS_M} m, none flagged.`;

  entries.forEach((e) => {
    const li = document.createElement('li');
    li.className = `near-item near-${e.band}`;
    const words = {
      danger: e.kind === 'police' ? '' : 'mostly reported unsafe',
      mixed: 'mixed reports',
      safe: 'mostly reported safe',
    }[e.band];
    const head = document.createElement('div');
    head.className = 'near-head';
    head.textContent = `${describeDistance(e.dist)} ${compassPoint(e.bearing)} — ${e.name}`;
    const sub = document.createElement('div');
    sub.className = 'near-sub';
    sub.textContent = [words, e.detail].filter(Boolean).join(' · ');
    li.appendChild(head);
    li.appendChild(sub);
    if (e.note) {
      const n = document.createElement('div');
      n.className = 'near-note';
      n.textContent = e.note;          // textContent: community and third-party text
      li.appendChild(n);
    }
    list.appendChild(li);
  });
}

document.getElementById('nearMeBtn').addEventListener('click', () => {
  cancelPicking();
  renderNearMe();
  openSheet('nearMeSheet');
  // Not awaited: the ratings are already on screen, and a slow Overpass must not hold the sheet
  // shut. The refuge list fills itself in underneath.
  loadRefuges();
});

document.getElementById('legendToggleBtn').addEventListener('click', () => {
  const panel = document.getElementById('legendPanel');
  const btn = document.getElementById('legendToggleBtn');
  panel.hidden = !panel.hidden;
  btn.setAttribute('aria-expanded', String(!panel.hidden));
});

// ---------- First-run walkthrough ----------
const ONBOARDED_KEY = 'safewalk_onboarded';
const onboardingSlides = [...document.querySelectorAll('.onboarding-slide')];
let onboardingIndex = 0;

function renderOnboardingDots() {
  document.getElementById('onboardingDots').innerHTML = onboardingSlides
    .map((_, i) => `<span class="onboarding-dot${i === onboardingIndex ? ' active' : ''}"></span>`)
    .join('');
}

function showOnboardingSlide(i) {
  onboardingIndex = i;
  onboardingSlides.forEach((s, idx) => { s.hidden = idx !== i; });
  renderOnboardingDots();
  document.getElementById('onboardingNext').textContent = i === onboardingSlides.length - 1 ? 'Get started' : 'Next';
}

function startOnboarding() {
  showOnboardingSlide(0);
  openSheet('onboardingSheet');
}

function finishOnboarding() {
  localStorage.setItem(ONBOARDED_KEY, '1');
  closeSheets();
}

document.getElementById('onboardingNext').addEventListener('click', () => {
  if (onboardingIndex < onboardingSlides.length - 1) showOnboardingSlide(onboardingIndex + 1);
  else finishOnboarding();
});
document.getElementById('onboardingSkip').addEventListener('click', finishOnboarding);
document.getElementById('showOnboardingBtn').addEventListener('click', startOnboarding);

// ---------- Accounts ----------
let authMode = 'signin';

function renderAccountState() {
  const stateEl = document.getElementById('accountState');
  const hintEl = document.getElementById('accountHint');
  const btn = document.getElementById('accountActionBtn');
  if (currentUser) {
    stateEl.textContent = currentUser.email || 'Signed in';
    hintEl.textContent = 'Your ratings are shared and synced across your devices.';
    btn.textContent = 'Sign out';
  } else {
    stateEl.textContent = 'Browsing without an account';
    hintEl.textContent = 'The map, routes and SOS all work as they are. Sign in when you want to add ratings of your own.';
    btn.textContent = 'Sign in';
  }
  // There is no password to change without an account, and offering one would be a dead end.
  const pw = document.getElementById('passwordSection');
  if (pw) pw.hidden = !currentUser;
  const del = document.getElementById('deleteAccountBtn');
  if (del) del.hidden = !currentUser;
}

document.getElementById('privacyBtn').addEventListener('click', () => openSheet('privacySheet'));

// Erasure, which the app owed and could not do until the delete-account function existed. The
// wording below is the whole point: a deletion that quietly leaves things behind is not a deletion,
// so what survives is said before the confirmation, not discovered afterwards.
document.getElementById('deleteAccountBtn').addEventListener('click', onceAtATime(async () => {
  const statusEl = document.getElementById('deleteAccountStatus');
  if (!currentUser || !sb) return;

  const ok = await showConfirm(
    'This deletes your account and email, your votes, your incident reports and your walks. '
    + 'Your street ratings stay on the map but are permanently unlinked from you, so other people '
    + 'keep the warnings. It cannot be undone.',
    { okLabel: 'Delete my account', title: 'Delete your account?' },
  );
  if (!ok) { openProfile(); return; }

  openProfile();
  setLoadingStatus(statusEl, 'Deleting your account…');
  const { data: session } = await sb.auth.getSession();
  const token = session && session.session ? session.session.access_token : null;
  if (!token) { statusEl.textContent = 'You are not signed in any more — sign in and try again.'; return; }

  const { error } = await settled((async () => {
    const res = await fetch(SUPABASE_URL + '/functions/v1/delete-account', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'Your session has expired. Sign in again, then delete.' : 'Could not delete the account.');
    return {};
  })(), 'delete your account');

  if (error) { statusEl.textContent = error.message; return; }

  // The account is gone server-side; clear the session locally so the app does not keep acting as
  // somebody who no longer exists.
  await settled(sb.auth.signOut({ scope: 'local' }), 'sign out');
  currentUser = null;
  renderAccountState();
  closeSheets();
  showToast('Your account has been deleted.', 5000);
}));

// ---------- Passwords ----------
// Two ways in, one set of rules. Changing your password asks for the current one first: Supabase
// will happily change it from an existing session alone, and this app is opened one-handed, on an
// unlocked phone, at night — somebody else holding that phone is exactly the case this has to
// survive, so a stolen unlocked phone must not be able to lock the owner out. Resetting by email
// skips that check, because following the emailed link already proves you control the address.
//
// Set by the PASSWORD_RECOVERY event, cleared once a new password is saved or the session ends.
// While it is true, Profile stops asking for the old password — otherwise someone who arrived by
// reset link and dismissed the sheet would be signed in, unable to remember their password, and
// facing a form that demands it: a dead end reachable in one tap.
let inPasswordRecovery = false;

// Returns a message to show, or '' when the pair is acceptable. Shared so the two forms can never
// drift into disagreeing about what a valid password is.
function newPasswordProblem(next, again, current) {
  if (!next) return 'Choose a new password.';
  // Supabase's own minimum. Checking here catches a typo before a round-trip, and names the rule
  // instead of echoing a server error.
  if (next.length < 6) return 'Your new password needs at least 6 characters.';
  if (next !== again) return 'The two new passwords do not match.';
  if (current && next === current) return 'That is already your password.';
  return '';
}

function resetPasswordForm() {
  const form = document.getElementById('passwordForm');
  const showBtn = document.getElementById('showPasswordFormBtn');
  if (!form || !showBtn) return;
  form.hidden = true;
  showBtn.hidden = false;
  ['currentPassword', 'newPassword', 'confirmPassword'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('passwordStatus').textContent = '';
  // After a reset link there is no old password to give, so the field is not merely optional —
  // showing it would be asking for something the person came here precisely because they lack.
  const currentField = document.getElementById('currentPassword');
  currentField.hidden = inPasswordRecovery;
  showBtn.textContent = inPasswordRecovery ? 'Set a new password' : 'Change my password';
}

document.getElementById('showPasswordFormBtn').addEventListener('click', () => {
  document.getElementById('showPasswordFormBtn').hidden = true;
  document.getElementById('passwordForm').hidden = false;
  document.getElementById(inPasswordRecovery ? 'newPassword' : 'currentPassword').focus();
});

document.getElementById('cancelPasswordBtn').addEventListener('click', resetPasswordForm);

document.getElementById('savePasswordBtn').addEventListener('click', guarded('passwordStatus', async () => {
  const statusEl = document.getElementById('passwordStatus');
  if (!sb) { statusEl.textContent = 'You are offline — reconnect to change your password.'; return; }
  if (!currentUser) { statusEl.textContent = 'Sign in first.'; return; }

  const current = document.getElementById('currentPassword').value;
  const next = document.getElementById('newPassword').value;
  const again = document.getElementById('confirmPassword').value;

  if (!inPasswordRecovery && !current) { statusEl.textContent = 'Enter your current password.'; return; }
  const problem = newPasswordProblem(next, again, inPasswordRecovery ? '' : current);
  if (problem) { statusEl.textContent = problem; return; }

  if (!inPasswordRecovery) {
    setLoadingStatus(statusEl, 'Checking your current password…');
    // Re-signing in with the same account refreshes the session rather than replacing the user, so
    // nothing on the map changes. A wrong password fails here and leaves the old one in place.
    const { error: reauthError } = await settled(sb.auth.signInWithPassword({
      email: currentUser.email,
      password: current,
    }), 'check your password');
    if (reauthError) {
      statusEl.textContent = reauthError.threw
        ? reauthError.message
        : 'That current password is not right.';
      return;
    }
  }

  setLoadingStatus(statusEl, 'Saving your new password…');
  const { error } = await settled(sb.auth.updateUser({ password: next }), 'save your new password');
  if (error) { statusEl.textContent = error.message; return; }

  inPasswordRecovery = false;
  resetPasswordForm();
  showToast('Password changed.');
  buzz();
}));

// ---------- Forgot your password ----------
// Where any emailed link comes back to. Sending the current page rather than a hardcoded address
// means this works from a local build, from GitHub Pages, and from anywhere else the app is ever
// hosted — but each of those origins has to be listed under Redirect URLs in the Supabase
// dashboard, or Supabase falls back to the project's Site URL instead.
//
// That fallback is why every email this app can send must pass this explicitly. The sign-up
// confirmation did not, from the day accounts shipped until 2026-09-08, so Supabase used the Site
// URL — still on its `http://localhost:3000` default — and every new user who tapped "confirm your
// email" on their phone landed on a page that does not exist. Nothing in the app could see that:
// from here a sign-up that is never confirmed and one that is confirmed onto a dead page look
// exactly the same.
function appRedirectUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

document.getElementById('authForgotBtn').addEventListener('click', guarded('authStatus', async () => {
  const statusEl = document.getElementById('authStatus');
  if (!sb) { statusEl.textContent = 'You are offline — reconnect to reset your password.'; return; }
  const email = document.getElementById('authEmail').value.trim();
  if (!email) { statusEl.textContent = 'Type your email address above first, then tap this again.'; return; }

  setLoadingStatus(statusEl, 'Sending your reset link…');
  const { error } = await settled(sb.auth.resetPasswordForEmail(email, { redirectTo: appRedirectUrl() }), 'send the link');
  // Deliberately the same message either way. Saying "no account with that email" would turn this
  // button into a way to test whether any given person uses SafeWalk — and on this app, that leaks
  // something about where they walk.
  // The one exception to saying the same thing either way: if the request never left the phone, no
  // link is on its way, and telling someone to go and wait for one is a lie that costs them the
  // evening. A connection failure says nothing about whether the account exists, so admitting it
  // leaks nothing.
  if (error && error.threw) { statusEl.textContent = error.message + ' Try again once you have a connection.'; return; }
  if (error && !/rate|limit|too many/i.test(error.message)) {
    statusEl.textContent = 'If there is an account for that address, a reset link is on its way. Check your spam folder too.';
    return;
  }
  statusEl.textContent = error
    ? 'Too many attempts just now. Wait a minute and try again.'
    : 'If there is an account for that address, a reset link is on its way. Check your spam folder too. Open it on this device.';
}));

function openNewPasswordSheet() {
  ['resetPassword', 'resetPasswordAgain'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('resetStatus').textContent = '';
  openSheet('newPasswordSheet');
}

document.getElementById('saveResetPasswordBtn').addEventListener('click', guarded('resetStatus', async () => {
  const statusEl = document.getElementById('resetStatus');
  if (!sb) { statusEl.textContent = 'You are offline — reconnect to finish this.'; return; }
  const next = document.getElementById('resetPassword').value;
  const again = document.getElementById('resetPasswordAgain').value;

  const problem = newPasswordProblem(next, again, '');
  if (problem) { statusEl.textContent = problem; return; }

  setLoadingStatus(statusEl, 'Saving your new password…');
  const { error } = await settled(sb.auth.updateUser({ password: next }), 'save your new password');
  // The commonest failure here is a link that has already expired or been used, and Supabase's own
  // wording for it is opaque. Say what to do instead.
  if (error) {
    statusEl.textContent = /session|expired|invalid|jwt/i.test(error.message)
      ? 'That reset link has expired. Ask for a new one from the sign-in screen.'
      : error.message;
    return;
  }

  inPasswordRecovery = false;
  resetPasswordForm();
  closeSheets();
  showToast('Password changed. You are signed in.');
  buzz();
}));

// ---------- Reporter standing ----------
// Only ever about yourself. There is no way to look up anyone else's accuracy, by design: a public
// score would invite harassment and would discourage exactly the unpopular warnings this app needs.
async function refreshStanding() {
  const row = document.getElementById('standingRow');
  if (!row) return;
  if (!currentUser) { row.hidden = true; return; }
  const { data, error } = await settled(sb.rpc('my_standing'), 'load your standing');
  if (error || !data || !data.length) { row.hidden = true; return; }
  const s = data[0];
  const total = Number(s.confirmations) + Number(s.contradictions);
  row.hidden = false;
  const headline = document.getElementById('standingHeadline');
  const detail = document.getElementById('standingDetail');

  if (!total) {
    headline.textContent = 'No feedback on your marks yet';
    detail.textContent = 'Once people walk routes past the places you have marked, their experience shows up here.';
    row.classList.remove('standing-warn');
    return;
  }
  const pct = Math.round((Number(s.confirmations) / total) * 100);
  if (s.in_cooldown) {
    row.classList.add('standing-warn');
    headline.textContent = 'New marks are paused';
    const until = s.cooldown_until ? new Date(s.cooldown_until).toLocaleDateString() : '';
    detail.textContent = `Most recent walkers disagreed with your marks (${pct}% matched, from ${total} reports). You can still vote and use every other feature; adding new marks unlocks again${until ? ' around ' + until : ' as older feedback ages out'}.`;
  } else {
    row.classList.remove('standing-warn');
    headline.textContent = `${pct}% of walkers agreed with your marks`;
    detail.textContent = `Based on ${total} report${total === 1 ? '' : 's'} from people who walked past them in the last 30 days.`;
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const signin = mode === 'signin';
  document.getElementById('authSheetTitle').textContent = signin ? 'Sign in' : 'Create account';
  document.getElementById('authSubmitBtn').textContent = signin ? 'Sign in' : 'Create account';
  document.getElementById('authToggleModeBtn').textContent = signin
    ? 'New here? Create an account'
    : 'Already have an account? Sign in';
  document.getElementById('authPassword').autocomplete = signin ? 'current-password' : 'new-password';
  // Nothing to recover on the way to a brand-new account, and offering it there invites people to
  // ask for a reset link for an address that has never signed up.
  document.getElementById('authForgotBtn').hidden = !signin;
  // When a write action sent us here, lead with what the sign-in is actually for.
  document.getElementById('authStatus').textContent = authReason ? `Sign in ${authReason}.` : '';
}

document.getElementById('accountActionBtn').addEventListener('click', async () => {
  if (!sb) return showToast('Cloud sync is unavailable — check your connection.');
  if (currentUser) {
    const ok = await showConfirm("Your ratings stay in your account. You'll still see the map, but you won't be able to add to it until you sign back in.", { okLabel: 'Sign out', title: 'Sign out?' });
    // Both paths land back on Profile, the sheet the button lives on — not the hub, which would
    // make cancelling a sign-out feel like something happened.
    if (!ok) { openProfile(); return; }

    // signOut() defaults to revoking the session on the server, and that request can fail — an
    // expired or already-revoked refresh token answers 403 — in which case supabase-js leaves the
    // local session exactly where it was. The result was a button that ran, said "Signed out", and
    // left you signed in: the error was never read.
    //
    // Signing out of THIS device never needs the server's permission. So when the round trip fails,
    // fall back to a local sign-out, which just drops the stored session. Anyone who needs every
    // device signed out can change their password, which revokes the rest.
    // Both calls are wrapped, because a rejected promise here is indistinguishable to the user from
    // the bug above: the await throws, every line after it is skipped, and the confirmation box just
    // closes onto an unchanged screen. The reporter described exactly that — confirmation appeared,
    // confirming did nothing — and an unhandled rejection inside an async click handler produces it
    // with no console message anyone walking home would ever see.
    let error = null;
    try {
      ({ error } = await sb.auth.signOut());
    } catch (thrown) {
      error = thrown || { message: 'sign-out failed' };
    }
    if (error) {
      try {
        ({ error } = await sb.auth.signOut({ scope: 'local' }));
      } catch (thrown) {
        error = thrown || { message: 'sign-out failed' };
      }
    }
    if (error) {
      // Not "clear my data on this device" — that button removes settings and the emergency
      // contact, and deliberately leaves the session alone, so suggesting it here would send
      // someone to wipe their contact for nothing.
      showToast('Could not sign out — you are still signed in. Check your connection and try again.');
      openProfile();
      return;
    }

    // onAuthStateChange normally does this, but it is driven by the same library call that just
    // struggled — so do not depend on it to have fired. Saying "Signed out" while still showing an
    // email address is precisely the bug being fixed.
    currentUser = null;
    renderAccountState();
    inPasswordRecovery = false;
    showToast('Signed out.');
    openProfile();
    return;
  }
  authReason = ''; // opened from the account row, not bounced here by a blocked action
  setAuthMode('signin');
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  openSheet('authSheet');
});

document.getElementById('authToggleModeBtn').addEventListener('click', () => {
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
});

document.getElementById('authSubmitBtn').addEventListener('click', guarded('authStatus', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const statusEl = document.getElementById('authStatus');
  if (!email || !password) { statusEl.textContent = 'Enter your email and password.'; return; }

  setLoadingStatus(statusEl, authMode === 'signin' ? 'Signing in…' : 'Creating your account…');
  const { data, error } = authMode === 'signin'
    ? await settled(sb.auth.signInWithPassword({ email, password }), 'sign you in')
    // emailRedirectTo, or the confirmation link goes to the project's Site URL — see appRedirectUrl().
    : await settled(sb.auth.signUp({ email, password, options: { emailRedirectTo: appRedirectUrl() } }), 'create your account');

  if (error) { statusEl.textContent = error.message; return; }

  // With email confirmation switched on (Supabase's default), signUp returns a user but no
  // session — nothing is signed in until they click the link in their inbox.
  if (!data.session) {
    statusEl.textContent = 'Check your email for a confirmation link, then sign in.';
    return;
  }
  statusEl.textContent = '';
  authReason = '';
  closeSheets();
  showToast(authMode === 'signin' ? 'Signed in.' : 'Account created.');
  buzz();
}));

// ---------- Cloud sync ----------
function rowToPin(row, myVotedIds) {
  return {
    id: row.id,
    lat: row.lat,
    lng: row.lng,
    radius: row.radius_m || undefined,
    paths: row.path || undefined,
    streetName: row.street_name || undefined,
    safe: Number(row.safe_count) || 0,
    danger: Number(row.danger_count) || 0,
    // Other voters' notes, anonymised by the view: text and rating only, never who wrote them
    // and never when, so they cannot be lined up into one person's route.
    notes: Array.isArray(row.vote_notes) ? row.vote_notes.filter((n) => n && n.text) : [],
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    // The view answers this itself; it deliberately never sends us anyone's user_id.
    own: !!row.is_mine,
    creatorRating: row.creator_rating,
    creatorNote: row.creator_note || '',
    source: row.source === 'route' ? 'route' : undefined,
    voters: myVotedIds.has(row.id) ? [currentVoterId()] : [],
  };
}

function pinToRow(pin) {
  return {
    user_id: currentUser.id,
    kind: pin.paths ? 'street' : pin.radius ? 'area' : 'spot',
    lat: pin.lat,
    lng: pin.lng,
    radius_m: pin.radius || null,
    path: pin.paths || null,
    street_name: pin.streetName || null,
    creator_rating: pin.creatorRating,
    creator_note: pin.creatorNote || null,
    source: pin.source === 'route' ? 'route' : 'manual',
  };
}

// Runs signed in or not: the map is public, so an anonymous visitor sees the same ratings.
// The extra votes query only makes sense with an account, so it's skipped when there isn't one.
// ---------- Offline read cache ----------
// The map is the whole product, and the person this app is for is often exactly the person with no
// signal — walking home, phone on 1 bar, wanting to know whether the next street is one people have
// flagged. So the last successfully loaded set of ratings is kept on the device and shown when the
// network is gone.
//
// This is a READ cache only. It is not a return to storing ratings locally: writing still requires
// an account and a connection, and anything cached here is replaced wholesale by the next
// successful fetch. It exists so the app can still answer a question, not so it can accept one.
const PIN_CACHE_KEY = 'safewalk_pins_cache';

function cachePins(rows) {
  try {
    localStorage.setItem(PIN_CACHE_KEY, JSON.stringify({
      at: Date.now(),
      userId: currentUser ? currentUser.id : null,
      rows,
    }));
  } catch {
    // Storage full or blocked. Not worth surfacing: the live path is unaffected.
  }
}

function loadCachedPins() {
  try {
    const c = JSON.parse(localStorage.getItem(PIN_CACHE_KEY) || 'null');
    if (!c || !Array.isArray(c.rows)) return null;
    // "own" was decided for whoever was signed in when this was cached. Trusting it for a different
    // (or absent) account would offer Edit and Delete on someone else's marks.
    const mine = c.userId && currentUser && c.userId === currentUser.id;
    const rows = mine ? c.rows : c.rows.map((r) => ({ ...r, is_mine: false }));
    return { rows, at: c.at };
  } catch {
    return null;
  }
}

// describeAge lives in geo.js and takes an age in milliseconds, not a timestamp — pure, so it can
// be tested. There used to be a second copy here taking a timestamp, which silently shadowed the
// geo.js one because app.js loads later; passing it a duration produced "20704 days ago".

function showStaleBanner(ts) {
  const el = document.getElementById('staleBanner');
  if (!el) return;
  el.textContent = `Offline — showing ratings saved ${describeAge(Date.now() - ts)}`;
  el.hidden = false;
}
function hideStaleBanner() {
  const el = document.getElementById('staleBanner');
  if (el) el.hidden = true;
}

// How much of the map to pull down at once. The old query was `select * from pins_with_scores`
// with no geographic filter, which downloads every pin in the country on every app open. That is
// invisible at two rows and ruinous at a city's worth — megabytes over mobile data, to someone
// walking home. pins_near has existed since migration 004 for exactly this and was never called.
//
// 5km is generous for a walk while still bounding the payload, and the refetch threshold is well
// inside it so panning never reveals an empty edge before the next fetch lands.
const PIN_FETCH_RADIUS_M = 5000;
const PIN_REFETCH_AFTER_M = 2000;
let lastPinFetchAt = null; // { lat, lng }
// True when the own-pins or votes fetch failed, so "My reports" and the vote state are known to be
// incomplete rather than known to be empty. The difference is the whole point.
let myHistoryIncomplete = false;

function pinFetchCentre() {
  // Prefer the person's actual position; fall back to whatever they are looking at.
  if (userLocation) return userLocation;
  const c = map.getCenter();
  return { lat: c.lat, lng: c.lng };
}

// An empty map is not a neutral thing to show. It reads as "nobody has reported anything here",
// which is the opposite of the truth when the real answer is "this app could not reach its data" —
// and on a safety map that is the most dangerous sentence it could accidentally say. The client is
// loaded from a CDN, so a blocked or slow jsdelivr on a mobile network leaves `sb` null and every
// cloud call a silent no-op: working map, working location dot, no pins, no explanation.
function reportNoBackend() {
  const cached = loadCachedPins();
  if (cached) {
    pins = cached.rows.map((r) => rowToPin(r, new Set()));
    renderPins();
    renderMyReports();
    showStaleBanner(cached.at);
    return;
  }
  const el = document.getElementById('staleBanner');
  if (el) {
    el.textContent = 'Could not reach the safety data — this map is not showing reports. Check your connection and reload.';
    el.hidden = false;
  }
}

async function refreshPinsFromCloud({ force = false } = {}) {
  if (!sb) return reportNoBackend();
  const centre = pinFetchCentre();
  if (!force && lastPinFetchAt &&
      haversine(centre.lat, centre.lng, lastPinFetchAt.lat, lastPinFetchAt.lng) < PIN_REFETCH_AFTER_M) {
    return; // still well inside what we already have
  }

  // Each leg is settled separately. Unguarded, one rejected fetch took the whole Promise.all down,
  // so the map never rendered AND the cached-pins fallback below never ran — the blank map this
  // function exists to prevent.
  const [nearby, own, votes] = await Promise.all([
    settled(sb.rpc('pins_near', { p_lat: centre.lat, p_lng: centre.lng, p_radius_m: PIN_FETCH_RADIUS_M }), 'load the map'),
    // Your own marks come along regardless of distance, or "My reports & marks" would quietly lose
    // anything you rated in another town. Bounded by one person's activity, so it stays small.
    currentUser ? settled(sb.from('pins_with_scores').select('*').eq('is_mine', true), 'load your marks') : Promise.resolve({ data: [] }),
    currentUser ? settled(sb.from('votes').select('pin_id').eq('user_id', currentUser.id), 'load your votes') : Promise.resolve({ data: [] }),
  ]);

  if (nearby.error) {
    // Fall back to whatever we last saw rather than showing an empty map, which would read as
    // "nothing has been reported here" — the opposite of the truth.
    const cached = loadCachedPins();
    if (cached) {
      pins = cached.rows.map((r) => rowToPin(r, new Set()));
      restorePendingPins(); // same reason as below: this assignment replaces the whole array
      renderPins();
      renderMyReports();
      showStaleBanner(cached.at);
    } else {
      // No cache to fall back on, but anything queued is still the walker's own work and must not
      // vanish just because the server could not be reached.
      restorePendingPins();
      renderPins();
      renderMyReports();
      showToast("Couldn't load the safety map — check your connection.");
    }
    return;
  }

  // The other two legs were never checked. Neither breaks the map, and that is exactly why they went
  // unnoticed — they quietly change what the app tells you about YOURSELF. A failed own-pins fetch
  // leaves own.data undefined, so "My reports & marks" renders its empty state and says "You haven't
  // added any ratings yet" to someone who has; a failed votes fetch leaves votedIds empty, so pins
  // you already rated invite you to rate them again, and the database refuses on submit. Both state
  // a falsehood confidently rather than admitting a gap. Spotted by the hourly agent, PR #13.
  myHistoryIncomplete = !!(own.error || votes.error);

  hideStaleBanner();
  lastPinFetchAt = centre;
  const votedIds = new Set((votes.data || []).map((v) => v.pin_id));
  const byId = new Map();
  [...(nearby.data || []), ...(own.data || [])].forEach((r) => byId.set(r.id, r));
  const rows = [...byId.values()];
  pins = rows.map((r) => rowToPin(r, votedIds));
  cachePins(rows);
  // Anything still queued is not in `rows` by definition, and this assignment has just replaced the
  // whole array — so without this the mark someone made in a tunnel disappears the next time the
  // map refreshes, which is the exact complaint the outbox exists to answer.
  restorePendingPins();
  renderPins();
  // A signal is back if this call succeeded, so this is the natural moment to drain the queue.
  flushOutbox();
  renderMyReports();
}

// Panning far enough should bring in that area's ratings; the distance guard above means this is
// cheap to call on every move.
map.on('moveend', () => { refreshPinsFromCloud(); });

// Every mutation goes through these. They're only reached past requireAccount(), so an unsigned
// call is a bug rather than a state to handle gracefully — hence the hard guard.
// A write that changes no rows is not the same as a write that fails, and row-level security
// produces the first kind: no error, nothing changed, everything looks fine. That is exactly how
// "editing your rating never updated your vote" survived unnoticed — persistUpdate awaited the
// call and inspected neither the error nor the result.
//
// Asking for the affected rows back turns that silence into something visible. Used for the two
// writes that carry the creator's own rating, because that rating is what colours the pin: if it
// does not save, the map shows the wrong answer while appearing to have worked.
async function writeExpectingRows(query, what) {
  const { data, error } = await settled(query.select('pin_id'), what);
  if (error) {
    showToast(`Could not ${what}: ${error.message}`);
    return false;
  }
  if (!Array.isArray(data) || !data.length) {
    console.warn(`SafeWalk: "${what}" was accepted but changed no rows — most likely a row-level security policy.`);
    showToast(`Could not ${what} — the change may not have saved.`);
    return false;
  }
  return true;
}
// call is a bug rather than a state to handle gracefully — hence the hard guard.
async function persistCreate(pin) {
  if (!currentUser) return;
  const { data, error } = await settled(sb.from('pins').insert(pinToRow(pin)).select('id').single(), 'save that mark');
  if (error) {
    // The cooldown is enforced by a row-level-security policy, so a suspended account gets a
    // generic policy violation. Translate it, or the person is left guessing why nothing saved.
    const blocked = /row-level security|policy/i.test(error.message || '');
    pins = pins.filter((x) => x.id !== pin.id); // it never reached the server; don't pretend it did
    renderPins();
    renderMyReports();
    if (blocked) {
      showToast('Your marks are paused for now — see My Page for why.');
      refreshStanding();
    } else if (error.threw) {
      // No connection. The mark is kept on the device and sent when there is one, so it stays on
      // the map — labelled, not pretended to be saved. Marking a street is most useful exactly
      // where the signal is worst, so this is the normal path, not an edge case.
      queueWrite({ kind: 'pin', localId: pin.id, row: pinToRow(pin) });
      const restored = { ...pin, pending: true };
      pins.push(restored);
      renderPins();
      renderMyReports();
      showToast('No signal — kept on your phone and uploaded when you are back online.', 4000);
    } else {
      showToast('Could not save to your account: ' + error.message);
    }
    return;
  }
  pin.id = data.id; // swap the local temp id for the real one
  await writeExpectingRows(
    sb.from('votes').insert({ pin_id: pin.id, user_id: currentUser.id, rating: pin.creatorRating }),
    'record your rating'
  );
}

async function persistUpdate(pin) {
  if (!currentUser) return;
  const { error } = await settled(sb.from('pins').update({
    lat: pin.lat, lng: pin.lng, radius_m: pin.radius || null, path: pin.paths || null,
    street_name: pin.streetName || null, creator_rating: pin.creatorRating,
    creator_note: pin.creatorNote || null,
  }).eq('id', pin.id), 'save changes');
  if (error) { showToast('Could not save changes: ' + error.message); return; }
  await writeExpectingRows(
    sb.from('votes').update({ rating: pin.creatorRating }).eq('pin_id', pin.id).eq('user_id', currentUser.id),
    'update your rating'
  );
}

async function persistDelete(id) {
  if (!currentUser) return;
  const { error } = await settled(sb.from('pins').delete().eq('id', id), 'delete that mark');
  if (error) showToast('Could not delete: ' + error.message);
}

// Feeds the reputation system: tells the database that this walker's verdict either backed up or
// contradicted whoever marked each pin. Which account wrote which pin stays server-side — the
// function looks that up itself, so nothing here reveals authorship.
async function recordRouteJudgement(pinIds, rating) {
  if (!currentUser || !pinIds.length) return;
  const { error } = await settled(sb.rpc('record_route_judgement', { p_pin_ids: pinIds, p_rating: rating }), 'record that');
  // Deliberately quiet: this is bookkeeping about other people, and the walker's own feedback has
  // already been saved. Failing it loudly would be noise they can do nothing about.
  if (error) console.warn('Could not record route judgement:', error.message);
}

async function persistVote(pinId, rating, note) {
  if (!currentUser) return;
  // The (pin_id, user_id) primary key is what actually guarantees one vote per person here.
  const row = { pin_id: pinId, user_id: currentUser.id, rating };
  // The note is the useful half of a rating: "mostly reported unsafe" says little, "no lighting
  // past the underpass, fine before 10pm" says what to do. It was being dropped entirely.
  if (note && note.trim()) row.note = note.trim().slice(0, 140);
  const { error } = await settled(sb.from("votes").insert(row), 'save your vote');
  if (error && error.threw) {
    queueWrite({ kind: 'vote', row });
    showToast('No signal — your rating is kept on your phone and sent when you are back online.', 4000);
    return;
  }
  if (error) {
    showToast(error.message.includes('duplicate') ? "You've already rated this spot." : 'Could not save your vote.');
  }
}

if (sb) {
  // Fires on load with the restored session too, so this is also how the map gets its first fill.
  sb.auth.onAuthStateChange(async (event, session) => {
    currentUser = session ? session.user : null;
    // Arriving from a reset link. Supabase has already turned the token in the URL into a real
    // session by this point, so without this the link would just sign someone in and leave them
    // exactly where they started: unable to remember the password, with no way to set a new one.
    if (event === 'PASSWORD_RECOVERY') {
      inPasswordRecovery = true;
      resetPasswordForm();
      openNewPasswordSheet();
    } else if (event === 'SIGNED_OUT') {
      inPasswordRecovery = false;
    }
    renderAccountState();
    // Forced: signing in or out changes is_mine on every row, so the cached set is wrong even
    // though the location has not moved.
    await refreshPinsFromCloud({ force: true });
    refreshStanding();
  });
}


// ---------- Walk mode ----------
// Rating a street from an armchair and rating it while walking down it are different problems. At
// home the hard part is WHERE — you tap a map, aim at a road, choose spot or street. While walking,
// the app already knows where you are, so the only thing left to say is how it felt. That is one
// bit, and it should cost one press: no aiming, no reading, no precision.
//
// Three decisions follow from that, and none of them are cosmetic.
//
// A mark covers the stretch just walked, not a point. Nobody stops mid-street to rate it — you keep
// going and reach for the phone once you are past, so a point dropped at the moment of the tap is
// already tens of metres wrong and says the wrong thing. WALK_MARK_SPAN_M of route behind you is
// both what you meant and what survives a GPS fix that is 20m out.
//
// A press votes on an existing pin wherever there is one, and only creates a new pin when there is
// not. That is better evidence — agreement concentrates instead of scattering — and it is also the
// stronger privacy position: votes are readable only by their author, so a walk through a
// well-covered area leaves nothing new on the public map at all.
//
// A press is not written for WALK_UNDO_MS. A misfire in your pocket is likelier than a considered
// tap here, and an undo that has to reach the database to take something back is an undo that
// leaves a trace. Anything still pending is flushed the moment the page is hidden, so locking the
// phone commits the mark rather than losing it.
const WALK_MARK_SPAN_M = 100;
const WALK_UNDO_MS = 4000;
// Beyond this, "the stretch you just walked" is not a stretch of the route at all. Marking anyway
// would put someone's warning on a street they were nowhere near.
const WALK_OFF_ROUTE_M = 120;

let walkState = null;

function walkBarEl() { return document.getElementById('walkBar'); }
function setWalkStatus(text) { document.getElementById('walkStatus').textContent = text; }

function startWalk() {
  if (!activeRouteCoords || activeRouteCoords.length < 2) {
    showToast('Pick a route first, then start walking it.');
    return;
  }
  // Asked for now rather than at the first press: being bounced to a sign-in sheet mid-street, one
  // handed, is exactly the moment not to ask.
  if (!requireAccount('to mark streets while you walk')) return;

  walkState = { coords: activeRouteCoords, index: 0, marked: 0, pending: null, timer: null, watchId: null };
  if (watchedWalk) { watchedWalk.lastMovedAt = Date.now(); startWalkIdleWatch(); }
  closeSheets();
  walkBarEl().hidden = false;
  document.querySelector('.bottom-bar').hidden = true;
  setWalkStatus('Walking — tap either button for the stretch you just passed');

  if (navigator.geolocation) {
    walkState.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (!walkState) return;
        userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        updateUserMarker(userLocation.lat, userLocation.lng, pos.coords.accuracy);
        // From the last known index forward: a route that doubles back past its own start would
        // otherwise snap the return leg onto the outbound one and mark the wrong half.
        const p = routeProgress(walkState.coords, userLocation.lat, userLocation.lng, walkState.index);
        if (p) { walkState.index = p.index; walkState.offRouteM = p.offRouteM; walkState.hasFix = true; }
        // A watched walk also tells the watcher where you are, and notices when you stop.
        if (watchedWalk) {
          if (!walkState.lastSeen || haversine(walkState.lastSeen.lat, walkState.lastSeen.lng, userLocation.lat, userLocation.lng) > WALK_MOVED_M) {
            walkState.lastSeen = { ...userLocation };
            noteWalkMovement();
            cancelWalkAlarm(); // moving again is the clearest possible "I am fine"
          }
          pushWalkPosition();
        }
      },
      () => {
        // Never over the undo line: that message is time-limited and is the only way back from a
        // misfire, and a location warning that erases it costs more than it explains.
        if (walkState && !walkState.pending) setWalkStatus('Waiting for your location — marks are paused until it arrives.');
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }
}

function finishWalk({ silent = false } = {}) {
  if (!walkState) return;
  flushWalkMark();
  if (walkState.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(walkState.watchId);
  const marked = walkState.marked;
  walkState = null;
  // Finishing is the walker saying they arrived, which is the whole point of the watcher's page.
  clearInterval(walkIdleTimer);
  endWatchedWalk('arrived');
  walkBarEl().hidden = true;
  document.querySelector('.bottom-bar').hidden = false;
  if (silent) return;
  // The one question worth asking, asked at the only moment it can be answered honestly: after the
  // walk. Most people will not have touched the phone on the way, so this is what catches them —
  // and the sheet now contains nothing else, because a route planner is not what somebody who has
  // just got home is looking at.
  setRouteStep('feedback');
  openSheet('routeSheet');
  showToast(marked
    ? `Walk finished — ${marked} stretch${marked === 1 ? '' : 'es'} marked.`
    : 'Walk finished.');
}

// Writes the pending mark for real. Called by the undo timer, by anything that supersedes it, and
// by the page-hidden handler — so a mark is never lost to a locked screen, only ever to a
// deliberate undo.
function flushWalkMark() {
  if (!walkState || !walkState.pending) return;
  const mark = walkState.pending;
  walkState.pending = null;
  clearTimeout(walkState.timer);
  walkState.timer = null;

  const mid = pathMidpoint(mark.path);
  const existing = mid ? findNearbyPin(mid.lat, mid.lng, 60) : null;
  const voterId = currentVoterId();

  if (existing) {
    if ((existing.voters || []).includes(voterId)) {
      // Marks span WALK_MARK_SPAN_M and match within 60m of their middle, so two presses less than
      // about 60m apart are describing the same stretch. One rating per person per stretch is the
      // rule everywhere else in the app and it holds here — but the bar has to say so, or a press
      // that changes nothing reads as a press that did not register.
      setWalkStatus(existing.own
        ? 'Already marked this stretch — walk on a little and tap again for the next one.'
        : 'You rated this stretch before, so it still counts once.');
      return;
    }
    if (mark.rating === 'safe') existing.safe++; else existing.danger++;
    existing.voters = [...(existing.voters || []), voterId];
    if (!existing.own) recordRouteJudgement([existing.id], mark.rating);
    persistVote(existing.id, mark.rating, '');
  } else {
    const pin = {
      id: 'p-' + Math.random().toString(36).slice(2),
      lat: mid.lat,
      lng: mid.lng,
      paths: [mark.path],
      streetName: undefined,
      safe: mark.rating === 'safe' ? 1 : 0,
      danger: mark.rating === 'danger' ? 1 : 0,
      notes: [],
      createdAt: Date.now(),
      own: true,
      source: 'route',
      creatorRating: mark.rating,
      creatorNote: '',
      voters: [voterId],
    };
    pins.push(pin);
    persistCreate(pin);
  }
  walkState.marked++;
  renderPins();
}

function undoWalkMark() {
  if (!walkState || !walkState.pending) return;
  clearTimeout(walkState.timer);
  walkState.pending = null;
  walkState.timer = null;
  setWalkStatus('Taken back. Nothing was saved.');
  buzz(10);
}

function markWalk(rating) {
  if (!walkState) return;
  // Without a fix, walkState.index is still 0 — so a press here would quietly mark the START of the
  // route as though you had walked it, which is a false warning on a street you may never have set
  // foot on. Refusing and saying why is the only honest option; this app must not invent evidence.
  if (!walkState.hasFix) {
    setWalkStatus('No location fix yet, so there is no stretch to mark. Nothing was saved.');
    return;
  }
  if (walkState.offRouteM != null && walkState.offRouteM > WALK_OFF_ROUTE_M) {
    setWalkStatus(`You are about ${Math.round(walkState.offRouteM)}m off this route — rejoin it to mark a stretch.`);
    return;
  }
  const path = trailingRouteSegment(walkState.coords, walkState.index, WALK_MARK_SPAN_M);
  if (!path) { setWalkStatus('Not enough of the route walked yet to mark a stretch.'); return; }

  // A second press supersedes the first rather than queuing behind it: two taps inside the undo
  // window is someone correcting themselves, not someone marking two stretches of the same 100m.
  if (walkState.pending) undoWalkMark();
  walkState.pending = { rating, path };
  setWalkStatus(rating === 'safe' ? 'Marked as fine — tap here to undo' : 'Marked as off — tap here to undo');
  document.getElementById('walkStatus').classList.add('walk-undoable');
  buzz(rating === 'safe' ? 15 : 30);
  walkState.timer = setTimeout(() => {
    flushWalkMark();
    if (!walkState) return;
    document.getElementById('walkStatus').classList.remove('walk-undoable');
    setWalkStatus('Saved. Keep going — tap again whenever it changes.');
  }, WALK_UNDO_MS);
}

document.getElementById('startWalkBtn').addEventListener('click', startWalk);
document.getElementById('walkFineBtn').addEventListener('click', () => markWalk('safe'));
document.getElementById('walkOffBtn').addEventListener('click', () => markWalk('danger'));
document.getElementById('walkFinishBtn').addEventListener('click', () => finishWalk());
// The status line is the undo target for a mark, and while the alarm is counting down it is the
// way out of that too — one tap, in the place the thumb already went, without unlocking anything.
document.getElementById('walkStatus').addEventListener('click', () => {
  if (alarmCountdown) { cancelWalkAlarm(); setWalkStatus('Alarm cancelled. Still walking.'); return; }
  undoWalkMark();
});

// A locked screen or a switched app must commit what is pending, not drop it. pagehide is the one
// that actually fires when a phone browser is backgrounded; visibilitychange covers the rest.
window.addEventListener('pagehide', flushWalkMark);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushWalkMark(); });


// ---------- Outbox ----------
// Marks made without a signal used to be lost: honestly refused, since the last fix, but still
// lost. That is the wrong answer for this app in particular. Walk mode exists to be used while
// walking, and walking is exactly when a phone drops to no bars — so the moment the feature is most
// useful is the moment its writes are most likely to fail. Losing a warning someone stopped to
// record, because a tunnel ate the request, is not acceptable.
//
// So a failed write is kept on the device and sent later. Two rules keep this honest:
//
//   A queued mark stays visible and is labelled. It is not pretended to be saved, and it does not
//   vanish either — both of those were the original bug in different directions.
//
//   Only a *connection* failure is queued. A mark the server actively refused — the reputation
//   cooldown, a duplicate vote — will be refused identically in an hour, so retrying it forever
//   would be a queue that never drains and a promise that is never kept.
//
// The queue holds the walker's own unsent marks, on their own device, and is deleted entry by entry
// as each one lands. It is a record of where they have been, so it is capped, never uploaded
// anywhere except as the marks themselves, and deliberately not touched by "Clear my data on this
// device" — that button promises your ratings survive it, and these are ratings that have not been
// saved yet.
const OUTBOX_KEY = 'safewalk_outbox_v1';
const OUTBOX_MAX = 200;

function loadOutbox() {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveOutbox(items) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-OUTBOX_MAX)));
  } catch {
    // Storage full or blocked. Nothing useful to do — the caller has already told the walker
    // whether their mark was kept, and lying about it now would be worse than the failure.
  }
}
function outboxForMe() {
  return currentUser ? loadOutbox().filter((e) => e.userId === currentUser.id) : [];
}
function queueWrite(entry) {
  if (!currentUser) return;
  const items = loadOutbox();
  items.push({ ...entry, at: Date.now(), userId: currentUser.id });
  saveOutbox(items);
  renderMenuHints();
}

// A queued pin has no server id yet, so it keeps its local one until the insert succeeds.
function outboxEntryToPin(entry) {
  const r = entry.row;
  return {
    id: entry.localId,
    lat: r.lat,
    lng: r.lng,
    radius: r.radius_m || undefined,
    paths: r.path || undefined,
    streetName: r.street_name || undefined,
    safe: r.creator_rating === 'safe' ? 1 : 0,
    danger: r.creator_rating === 'danger' ? 1 : 0,
    notes: [],
    createdAt: entry.at,
    own: true,
    pending: true,
    source: r.source === 'route' ? 'route' : undefined,
    creatorRating: r.creator_rating,
    creatorNote: r.creator_note || '',
    voters: [entry.userId],
  };
}

// refreshPinsFromCloud replaces the whole pins array with what the server returned, which by
// definition does not include anything still queued. Without this the mark disappears from the map
// the moment the map refreshes — the original complaint, reproduced by the fix for it.
function restorePendingPins() {
  outboxForMe()
    .filter((e) => e.kind === 'pin')
    .forEach((e) => {
      if (!pins.some((p) => p.id === e.localId)) pins.push(outboxEntryToPin(e));
    });
}

async function sendOutboxEntry(entry) {
  if (entry.kind === 'pin') {
    const { data, error } = await settled(
      sb.from('pins').insert(entry.row).select('id').single(), 'save that mark');
    if (error) return error.threw ? 'retry' : 'refused';
    // The creator's own first vote is what gives the pin its score, exactly as in persistCreate.
    await settled(sb.from('votes').insert({
      pin_id: data.id, user_id: entry.userId, rating: entry.row.creator_rating,
    }), 'record your rating');
    const onScreen = pins.find((p) => p.id === entry.localId);
    if (onScreen) { onScreen.id = data.id; onScreen.pending = false; }
    return 'sent';
  }
  if (entry.kind === 'vote') {
    const { error } = await settled(sb.from('votes').insert(entry.row), 'save your vote');
    if (error) return error.threw ? 'retry' : 'refused';
    return 'sent';
  }
  return 'refused';
}

let flushingOutbox = false;
async function flushOutbox({ quiet = true } = {}) {
  if (flushingOutbox || !sb || !currentUser) return;
  const mine = outboxForMe();
  if (!mine.length) return;

  flushingOutbox = true;
  const keep = [];
  let sent = 0;
  let refused = 0;
  for (let i = 0; i < mine.length; i++) {
    const result = await sendOutboxEntry(mine[i]);
    if (result === 'sent') { sent++; continue; }
    if (result === 'refused') { refused++; continue; }
    // Still no connection. Keep this one and everything after it, in order, rather than grinding
    // the rest of the queue against a dead network.
    keep.push(...mine.slice(i));
    break;
  }
  // Anything belonging to another account on this device is left exactly as it was.
  saveOutbox([...loadOutbox().filter((e) => e.userId !== currentUser.id), ...keep]);
  flushingOutbox = false;

  if (sent) {
    renderPins();
    renderMyReports();
    if (!quiet) showToast(`${sent} mark${sent === 1 ? '' : 's'} uploaded.`);
  }
  if (refused) {
    showToast(`${refused} mark${refused === 1 ? '' : 's'} could not be saved and ${refused === 1 ? 'was' : 'were'} dropped — see My Page.`, 5000);
  }
  renderMenuHints();
}

// The browser tells us the moment a signal comes back, which is the one event worth acting on
// immediately: someone who marked a street in a tunnel gets it uploaded as they come out, without
// having to reopen anything.
window.addEventListener('online', () => flushOutbox({ quiet: false }));


// ---------- Watched walk ----------
// Someone follows your walk while it happens, on a link they open without an account and without
// installing anything — because the person you most want watching is a parent who will not do
// either. The link is a capability: whoever holds it can watch, so it is a secret like a door key,
// and it stops working after twelve hours.
//
// What is deliberately NOT built: nothing here calls anyone. A web page cannot dial — `tel:` needs a
// finger on the screen — so the app must never imply an escalation it cannot perform. The alarm is
// loud, on the walker's own phone, with the call one tap away. Reaching somebody who is not holding
// their phone needs server-side SMS, which is not built yet and is not pretended to be.

const WALK_PUSH_MS = 15000;       // how often the walker's position is sent while walking
const WATCH_POLL_MS = 10000;      // how often the watcher's page re-asks
const WALK_MOVED_M = 30;          // further than this counts as having moved
const WALK_IDLE_MS = 10 * 60 * 1000;
const WALK_ALARM_COUNTDOWN_MS = 60000;

let watchedWalk = null;   // { id, token } while a watched walk is running
let watchToken = null;    // set instead when this device is the WATCHER

// The screen must stay awake, because geolocation stops with it and a watcher staring at a frozen
// position learns nothing. The browser drops the lock whenever the page is hidden, so it is retaken
// on the way back — without that, one glance at another app ends the walk silently.
let wakeLock = null;
let wantWakeLock = false;
async function keepAwake(on) {
  wantWakeLock = on;
  try {
    if (!on) {
      if (wakeLock) { await wakeLock.release(); }
      wakeLock = null;
      return true;
    }
    if (!('wakeLock' in navigator)) return false;
    wakeLock = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    wakeLock = null;
    return false;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock && !wakeLock) keepAwake(true);
});

function walkShareUrl(token) {
  return appRedirectUrl() + '?watch=' + token;
}

// ---------- Walker's side ----------

document.getElementById('startWatchedWalkBtn').addEventListener('click', onceAtATime(async () => {
  if (!activeRouteCoords || activeRouteCoords.length < 2) { showToast('Pick a route first.'); return; }
  if (!requireAccount('to let someone watch your walk')) return;
  if (!sb) { showToast('You need a connection to start a watched walk.'); return; }

  const { data, error } = await settled(
    sb.from('walks').insert({ walker_id: currentUser.id }).select('id,share_token').single(),
    'start a watched walk');
  if (error) { showToast('Could not start a watched walk: ' + error.message); return; }

  watchedWalk = { id: data.id, token: data.share_token };
  document.getElementById('walkShareLink').value = walkShareUrl(data.share_token);
  document.getElementById('walkShareStatus').textContent = '';
  offerSmsToContact(data.share_token);
  openSheet('walkShareSheet');
}));

// The two message-app URL shapes are not interchangeable: RFC 5724 specifies `sms:number?body=`,
// which Android follows, while iOS has always wanted `sms:number&body=` and drops the text with the
// other one. Getting it wrong does not fail loudly — the messaging app opens with an empty message
// and the link silently missing, which is the worst kind of wrong for a share button.
function smsHref(number, body) {
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document);
  return 'sms:' + number + (apple ? '&' : '?') + 'body=' + encodeURIComponent(body);
}

// The emergency contact is the person most likely to be watching, and their number is already on
// this device — kept there, never uploaded. This only builds a link; the walker still presses send.
function offerSmsToContact(shareToken) {
  const btn = document.getElementById('walkShareSmsBtn');
  const none = document.getElementById('walkShareNoContact');
  const c = contacts[0];
  if (!c || !c.phone) {
    btn.hidden = true;
    none.hidden = false;
    return;
  }
  none.hidden = true;
  btn.hidden = false;
  btn.textContent = `Text the link to ${c.name || c.phone}`;
  btn.onclick = () => {
    const url = walkShareUrl(shareToken);
    window.location.href = smsHref(normalisePhone(c.phone),
      `I'm walking home. Follow me here and you'll see when I arrive: ${url}`);
    document.getElementById('walkShareStatus').textContent =
      'Your messages app should open with it ready — you still have to press send.';
  };
}

async function shareWalkLink() {
  const url = walkShareUrl(watchedWalk && watchedWalk.token);
  const statusEl = document.getElementById('walkShareStatus');
  // navigator.share opens the phone's own sheet, which is how this actually gets sent — SMS,
  // WhatsApp, whatever they already use with that person. Everything else is a fallback.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Follow my walk home', text: 'Follow my walk home on SafeWalk:', url });
      statusEl.textContent = 'Sent. Start walking when you are ready.';
      return;
    } catch {
      // Cancelled, or refused by the browser. Fall through to copying.
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    statusEl.textContent = 'Link copied — paste it to your watcher.';
  } catch {
    const field = document.getElementById('walkShareLink');
    field.focus();
    field.select();
    statusEl.textContent = 'Copy the link above and send it to your watcher.';
  }
}
document.getElementById('walkShareBtn').addEventListener('click', shareWalkLink);
document.getElementById('walkShareAgainBtn').addEventListener('click', shareWalkLink);

document.getElementById('walkShareCancelBtn').addEventListener('click', async () => {
  await endWatchedWalk('cancelled');
  closeSheets();
  showToast('Walk cancelled.');
});

document.getElementById('walkShareStartBtn').addEventListener('click', () => {
  startWalk();  // the ordinary walk bar, plus the watched strip below
  document.getElementById('walkWatchedStrip').hidden = false;
  keepAwake(true);
  pushWalkPosition(true);
});

// Only the latest position, replaced each time. There is no breadcrumb table on purpose: a watcher
// needs where you are, not where you have been, and the difference is the whole privacy argument.
let lastPushAt = 0;
async function pushWalkPosition(force = false) {
  if (!watchedWalk || !userLocation) return;
  const now = Date.now();
  if (!force && now - lastPushAt < WALK_PUSH_MS) return;
  lastPushAt = now;
  await settled(sb.from('walks').update({
    last_lat: userLocation.lat,
    last_lng: userLocation.lng,
    last_position_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', watchedWalk.id), 'update your watcher');
  // A failed push is not worth interrupting a walk for: the next one is fifteen seconds away, and
  // the watcher's page shows how stale its information is, which is the honest signal here.
}

async function endWatchedWalk(status) {
  if (!watchedWalk) return;
  const id = watchedWalk.id;
  watchedWalk = null;
  cancelWalkAlarm();
  keepAwake(false);
  document.getElementById('walkWatchedStrip').hidden = true;
  await settled(sb.from('walks').update({ status, updated_at: new Date().toISOString() }).eq('id', id), 'tell your watcher');
}

// ---------- The alarm ----------
// Fires when the walker has not moved for a long time. The countdown is the important part: stopping
// to talk to someone must not summon anybody, so there is always a way out, and it is one tap and
// needs no unlocking.
let walkIdleTimer = null;
let alarmCountdown = null;

function noteWalkMovement() {
  if (!watchedWalk) return;
  watchedWalk.lastMovedAt = Date.now();
}

function startWalkIdleWatch() {
  clearInterval(walkIdleTimer);
  walkIdleTimer = setInterval(() => {
    if (!watchedWalk || alarmCountdown) return;
    const since = Date.now() - (watchedWalk.lastMovedAt || Date.now());
    if (since >= WALK_IDLE_MS) beginWalkAlarmCountdown();
  }, 30000);
}

function beginWalkAlarmCountdown() {
  if (alarmCountdown) return;
  let left = Math.round(WALK_ALARM_COUNTDOWN_MS / 1000);
  buzz(400);
  const tick = () => {
    if (!alarmCountdown) return;
    setWalkStatus(`No movement for a while. Telling your watcher in ${left}s — tap here to cancel.`);
    document.getElementById('walkStatus').classList.add('walk-undoable');
    if (left <= 0) {
      cancelWalkAlarm();
      raiseWalkAlarm();
      return;
    }
    left--;
    buzz(60);
  };
  alarmCountdown = setInterval(tick, 1000);
  tick();
}

function cancelWalkAlarm() {
  if (!alarmCountdown) return;
  clearInterval(alarmCountdown);
  alarmCountdown = null;
  document.getElementById('walkStatus').classList.remove('walk-undoable');
  if (watchedWalk) watchedWalk.lastMovedAt = Date.now();
}

async function raiseWalkAlarm() {
  if (!watchedWalk) return;
  await settled(sb.from('walks').update({ status: 'alarm', updated_at: new Date().toISOString() })
    .eq('id', watchedWalk.id), 'raise the alarm');
  setWalkStatus('Your watcher has been told you have stopped.');
  buzz(800);
  // Deliberately no automatic call: the app cannot make one, so it must not claim to. The one thing
  // it can offer is the contact, one tap away, on a phone the walker is holding.
  const contact = contacts[0];
  showToast(contact && contact.phone
    ? `Your watcher has been told. Press SOS to call ${contact.name || contact.phone}.`
    : 'Your watcher has been told you have stopped moving.', 8000);
}

// ---------- Watcher's side ----------

let watchLayer = null;
let watchPollTimer = null;

function enterWatchMode(token) {
  watchToken = token;
  document.querySelector('.bottom-bar').hidden = true;
  document.getElementById('mapHint').hidden = true;
  document.getElementById('watchPanel').hidden = false;
  watchLayer = L.layerGroup().addTo(map);
  keepAwake(true);
  pollWatchedWalk();
  watchPollTimer = setInterval(pollWatchedWalk, WATCH_POLL_MS);
}

function leaveWatchMode() {
  clearInterval(watchPollTimer);
  watchPollTimer = null;
  watchToken = null;
  keepAwake(false);
  document.getElementById('watchPanel').hidden = true;
  document.querySelector('.bottom-bar').hidden = false;
  if (watchLayer) watchLayer.clearLayers();
  history.replaceState(null, '', location.pathname);
}
document.getElementById('watchStopBtn').addEventListener('click', leaveWatchMode);

async function pollWatchedWalk() {
  if (!watchToken || !sb) return;
  const dot = document.getElementById('watchDot');
  const headline = document.getElementById('watchHeadline');
  const detail = document.getElementById('watchDetail');
  const age = document.getElementById('watchAge');

  const { data, error } = await settled(sb.rpc('walk_by_token', { p_token: watchToken }), 'check the walk');
  if (error) {
    // Do not overwrite what is already on screen with a connection problem — the last known
    // position is still the most useful thing here, and its age is shown below it.
    age.textContent = 'Cannot reach SafeWalk right now — still trying.';
    return;
  }

  const walk = Array.isArray(data) ? data[0] : data;
  if (!walk) {
    dot.className = 'watch-dot watch-dot-ended';
    headline.textContent = 'Nothing to follow';
    detail.textContent = 'This link has expired, or the walk was never started. Ask them for a new one.';
    age.textContent = '';
    clearInterval(watchPollTimer);
    return;
  }

  const state = {
    walking:   { cls: 'watch-dot-live',  head: 'On their way',        text: 'They are walking. This updates on its own.' },
    arrived:   { cls: 'watch-dot-done',  head: 'They got there',      text: 'They marked themselves home safely.' },
    cancelled: { cls: 'watch-dot-ended', head: 'Walk ended',          text: 'They ended the walk.' },
    alarm:     { cls: 'watch-dot-alarm', head: 'They have stopped',   text: 'No movement for a while and they did not cancel. Try calling them.' },
  }[walk.status] || { cls: 'watch-dot-ended', head: 'Walk ended', text: '' };

  dot.className = 'watch-dot ' + state.cls;
  headline.textContent = state.head;
  detail.textContent = walk.label ? `${state.text} (${walk.label})` : state.text;

  if (walk.last_position_at) {
    age.textContent = 'Last seen ' + describeAge(Date.now() - new Date(walk.last_position_at).getTime()) + '.';
  } else {
    age.textContent = 'No position yet.';
  }

  if (walk.last_lat != null && walk.last_lng != null) {
    watchLayer.clearLayers();
    L.circleMarker([walk.last_lat, walk.last_lng], {
      radius: 9,
      color: token('--you', '#4a9eff'),
      fillColor: token('--you', '#4a9eff'),
      fillOpacity: 0.85,
      weight: 3,
    }).addTo(watchLayer);
    if (!watchLayer._centredOnce) {
      map.setView([walk.last_lat, walk.last_lng], 16, { animate: false });
      watchLayer._centredOnce = true;
    }
  }

  if (walk.status !== 'walking' && walk.status !== 'alarm') {
    clearInterval(watchPollTimer);
    watchPollTimer = null;
    keepAwake(false);
  }
}


// ---------- Somewhere to go ----------
// Every other layer in this app tells you what to avoid. This one tells you where to GO, which is
// what you want once something has already gone wrong: the nearest door you can walk through, open
// now, with people behind it.
//
// No new data source and no partnerships. OpenStreetMap already knows, and the app already talks to
// Overpass for street geometry. Measured over central Oslo on 2026-09-08: 1282 candidate places,
// 773 with opening hours, 27 tagged 24/7 — and the coverage is best where it matters, supermarkets
// 147/150 and pharmacies 46/50.
//
// The ranking is not just distance. A pharmacy and a hospital are places whose whole purpose is to
// help someone in trouble; a restaurant is somewhere with people and light. Both beat a closer door
// that might be an empty forecourt, so kind breaks ties before distance does.
const REFUGE_RADIUS_M = 700;
const REFUGE_SHOW = 5;

// Lower sorts first. Judgement, and it should be argued with rather than tuned quietly: these are
// ordered by how likely someone inside is to help a frightened stranger, not by how near they are.
const REFUGE_KINDS = {
  hospital:    { rank: 0, label: 'Hospital' },
  police:      { rank: 1, label: 'Police station' },
  pharmacy:    { rank: 2, label: 'Pharmacy' },
  fuel:        { rank: 3, label: 'Petrol station' },
  supermarket: { rank: 4, label: 'Supermarket' },
  convenience: { rank: 4, label: 'Shop' },
  hotel:       { rank: 5, label: 'Hotel' },
  cafe:        { rank: 6, label: 'Café' },
  restaurant:  { rank: 6, label: 'Restaurant' },
  bar:         { rank: 7, label: 'Bar' },
};

let refugeLoadedFor = null;

function refugeKindOf(tags) {
  return REFUGE_KINDS[tags.amenity] ? tags.amenity
    : REFUGE_KINDS[tags.shop] ? tags.shop
    : tags.tourism === 'hotel' ? 'hotel'
    : null;
}

// Hands the refuge to the ordinary route planner rather than inventing a second one, so it gets the
// same hazard-aware ranking as any other walk — which matters here more than anywhere: being sent
// towards a police cordon while trying to get away from something would be the worst possible bug
// in this feature.
// Back a step, without throwing away the search.
document.getElementById('routeChangeBtn').addEventListener('click', () => setRouteStep('choose'));
document.getElementById('routeNewSearchBtn').addEventListener('click', () => {
  routeLayer.clearLayers();
  activeRouteCoords = null;
  document.getElementById('routeResults').innerHTML = '';
  document.getElementById('routeStatus').textContent = '';
  setRouteStep('plan');
});

// Reporting mid-walk. No map to aim at — it takes where you are standing, which is the only
// position that makes sense while walking and the only one anyone could give one-handed.
document.getElementById('walkReportBtn').addEventListener('click', () => {
  if (!userLocation) { showToast('Waiting for your location — try again in a moment.'); return; }
  pendingPoint = { lat: userLocation.lat, lng: userLocation.lng };
  document.getElementById('openIncidentBtn').click();
});

function routeToRefuge(p) {
  routePins.from = null;                       // null means "from where I am now"
  routePins.to = { lat: p.lat, lng: p.lng, label: p.name };
  document.getElementById('routeFrom').value = '';
  document.getElementById('routeTo').value = p.name;
  closeSheets();
  openSheet('routeSheet');
  document.getElementById('findRouteBtn').click();
}

async function loadRefuges() {
  const summary = document.getElementById('refugeSummary');
  const list = document.getElementById('refugeList');
  if (!userLocation) {
    summary.textContent = 'Turn on location to see places you can walk into nearby.';
    list.innerHTML = '';
    return;
  }
  const key = userLocation.lat.toFixed(3) + ',' + userLocation.lng.toFixed(3);
  if (refugeLoadedFor === key && list.children.length) return; // already answered for here
  refugeLoadedFor = key;

  setLoadingStatus(summary, 'Looking for places that are open…');
  list.innerHTML = '';

  const { lat, lng } = userLocation;
  const q = `[out:json][timeout:20];(` +
    `node["amenity"~"^(pharmacy|hospital|police|fuel|cafe|bar|restaurant)$"](around:${REFUGE_RADIUS_M},${lat},${lng});` +
    `node["shop"~"^(convenience|supermarket)$"](around:${REFUGE_RADIUS_M},${lat},${lng});` +
    `node["tourism"="hotel"](around:${REFUGE_RADIUS_M},${lat},${lng});` +
    `);out tags center;`;

  // Both mirrors, in turn. The main one rate-limits in earnest — measured here, three refuge
  // queries in a few minutes and it started refusing — and this is the layer someone reaches for
  // when they already want to be somewhere else, so one throttled host must not be the end of it.
  let res = null;
  for (const mirror of OVERPASS_MIRRORS) {
    res = await fetchWithTimeout(mirror, {
      method: 'POST',
      body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, 20000);
    if (res) break;
  }

  if (!res) {
    // The house rule: a failure must not read as "there is nowhere to go".
    summary.textContent = isOffline()
      ? 'You are offline, so nearby places cannot be looked up.'
      : 'Could not look up nearby places just now.';
    refugeLoadedFor = null; // so it tries again next time the sheet opens
    return;
  }

  let data;
  try { data = await res.json(); } catch { data = null; }
  const candidates = ((data && data.elements) || [])
    .map((el) => {
      const tags = el.tags || {};
      const kind = refugeKindOf(tags);
      const elLat = el.lat != null ? el.lat : el.center && el.center.lat;
      const elLng = el.lon != null ? el.lon : el.center && el.center.lon;
      if (!kind || !tags.name || elLat == null || elLng == null) return null;
      return {
        name: tags.name,
        kind,
        lat: elLat,
        lng: elLng,
        open: isOpenNow(tags.opening_hours),
        dist: haversine(lat, lng, elLat, elLng),
      };
    })
    .filter(Boolean)
    // Anything known to be shut is useless right now and is dropped. Unknown is kept, labelled —
    // a hotel lobby whose hours nobody recorded is still worth knowing about at 1am.
    .filter((p) => p.open !== false);

  // Confirmed open comes first, ahead of kind. Sorting by kind alone returned five pharmacies for
  // central Oslo — and at 1am, which is when anyone needs this, every one of them is shut and four
  // were only on the list because their hours are unrecorded. A café we know is open beats a
  // pharmacy that might be.
  //
  // Then at most two of any one kind, so the list cannot fill up with the same shop again.
  const perKind = {};
  const found = candidates
    .sort((a, b) =>
      (Number(b.open === true) - Number(a.open === true))
      || (REFUGE_KINDS[a.kind].rank - REFUGE_KINDS[b.kind].rank)
      || (a.dist - b.dist))
    .filter((p) => {
      perKind[p.kind] = (perKind[p.kind] || 0) + 1;
      return perKind[p.kind] <= 2;
    })
    .slice(0, REFUGE_SHOW);

  if (!found.length) {
    summary.textContent = 'Nothing open found within a few minutes’ walk.';
    return;
  }

  summary.textContent = `${found.length} place${found.length === 1 ? '' : 's'} you could walk into now:`;
  found.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'near-item refuge-item';
    const bearing = compassPoint(bearingDegrees(lat, lng, p.lat, p.lng));
    li.innerHTML = `
      <div class="near-item-main">
        <strong>${p.name}</strong>
        <span class="refuge-kind">${REFUGE_KINDS[p.kind].label}</span>
      </div>
      <div class="near-item-sub">
        ${describeDistance(p.dist)} ${bearing}
        · <span class="${p.open ? 'refuge-open' : 'refuge-unknown'}">${p.open ? 'Open now' : 'Hours not recorded'}</span>
      </div>`;
    li.addEventListener('click', () => {
      closeSheets();
      map.setView([p.lat, p.lng], 17);
    });

    // Showing someone a dot on a map is not the same as getting them there. This is the only part
    // of the app that answers "where do I go", and it should finish the sentence.
    const go = document.createElement('button');
    go.className = 'btn btn-secondary refuge-go';
    go.textContent = 'Walk me there';
    go.addEventListener('click', (e) => {
      e.stopPropagation();
      routeToRefuge(p);
    });
    li.appendChild(go);

    list.appendChild(li);
  });
}


// ---------- Incidents ----------
// An assertion that something happened, not an opinion about a place, and treated differently
// throughout: its own colour, its own shape on the map, its own seven-day life, and the only thing
// in this app anyone else can vote down.
//
// Drawn as a marker with a warning glyph, never as the police layer's dashed area. If a stranger's
// report can be mistaken for an official one, the app has laundered a claim into a police record —
// and the map key says which is which.
const INCIDENT_KINDS = {
  assault:     { label: 'Assault', glyph: '⚠' },
  robbery:     { label: 'Robbery or theft', glyph: '⚠' },
  harassment:  { label: 'Harassment', glyph: '⚠' },
  hazard:      { label: 'Unsafe place', glyph: '⚠' },
};
// Voting counts double from someone who was near it. A weight, never a gate — see ROADMAP.md.
const INCIDENT_NEARBY_M = 250;
const INCIDENT_FETCH_RADIUS_M = 5000;

const incidentLayer = L.layerGroup().addTo(map);
let incidents = [];
let pendingIncidentKind = null;
let activeIncidentId = null;

async function loadIncidents() {
  if (!sb) return;
  const c = typeof pinFetchCentre === 'function' ? pinFetchCentre() : userLocation;
  if (!c) return;
  const { data, error } = await settled(
    sb.rpc('incidents_near', { p_lat: c.lat, p_lng: c.lng, p_radius_m: INCIDENT_FETCH_RADIUS_M }),
    'load reported incidents');
  // Quiet on failure: the pins path already reports a lost connection, and a second banner saying
  // the same thing is noise. What must never happen is an empty layer reading as "nothing reported".
  if (error || !Array.isArray(data)) return;
  incidents = data;
  renderIncidents();
  checkIncidentProximity();
}

// Walking towards one is the moment this data is worth anything. The police layer has warned people
// since it shipped; user reports did not, which meant the freshest warning on the map — the one
// somebody stopped in the street to record — was the one that stayed silent.
//
// Two limits keep it from becoming noise, and both are deliberate rather than tuned:
// only reports from the last day (a six-day-old incident is map context, not a warning worth a
// buzz), and never your own.
const INCIDENT_ALERT_RADIUS_M = 150;
const INCIDENT_ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const alertedIncidentIds = new Set();

function checkIncidentProximity() {
  if (!userLocation || !incidents.length) return;
  const near = incidents.filter((inc) => {
    if (alertedIncidentIds.has(inc.id) || inc.is_mine) return false;
    if (Date.now() - new Date(inc.occurred_at).getTime() > INCIDENT_ALERT_MAX_AGE_MS) return false;
    return haversine(userLocation.lat, userLocation.lng, inc.lat, inc.lng) <= INCIDENT_ALERT_RADIUS_M;
  });
  if (!near.length) return;
  near.forEach((inc) => alertedIncidentIds.add(inc.id));
  showIncidentAlert(near);
}

function showIncidentAlert(list) {
  const el = document.getElementById('policeAlert');
  if (!el) return;
  const first = list[0];
  const what = (INCIDENT_KINDS[first.category] || {}).label || 'an incident';
  const when = describeAge(Date.now() - new Date(first.occurred_at).getTime());
  const confirmed = Number(first.confirmed) || 0;
  // "Someone using SafeWalk" every time, and a different colour from the police banner. The whole
  // safeguard is that a stranger's report can never be mistaken for an official one — a warning
  // that borrows the police layer's authority is exactly the laundering this design forbids.
  el.classList.add('alert-user-report');
  el.querySelector('.police-alert-text').textContent = list.length === 1
    ? `Someone using SafeWalk reported ${what.toLowerCase()} near here, ${when}` +
      (confirmed ? ` — ${confirmed} other${confirmed === 1 ? '' : 's'} confirmed it.` : ', not yet confirmed by anyone else.')
    : `${list.length} reports from other people near here.`;
  el.hidden = false;
  buzz();
  el.onclick = () => { el.hidden = true; el.classList.remove('alert-user-report'); openIncidentView(first.id); };
  const dismiss = el.querySelector('.police-alert-dismiss');
  if (dismiss) dismiss.onclick = (ev) => { ev.stopPropagation(); el.hidden = true; el.classList.remove('alert-user-report'); };
}

function renderIncidents() {
  incidentLayer.clearLayers();
  incidents.forEach((inc) => {
    const marker = L.marker([inc.lat, inc.lng], {
      icon: L.divIcon({
        className: 'incident-marker',
        html: `<span class="incident-glyph"><i>${(INCIDENT_KINDS[inc.category] || {}).glyph || '⚠'}</i></span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      keyboard: false,
    });
    marker.on('click', (e) => {
      if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
      openIncidentView(inc.id);
    });
    marker.addTo(incidentLayer);
  });
}

// ---------- Reporting one ----------

document.getElementById('openIncidentBtn').addEventListener('click', () => {
  if (!pendingPoint) { showToast('Tap the map where it happened first.'); return; }
  pendingIncidentKind = null;
  // If a previous attempt threw, the in-flight flag and the disabled button would otherwise stay
  // stuck for the rest of the session — a guard that locks people out is its own bug.
  incidentSubmitInFlight = false;
  document.querySelectorAll('#incidentKinds .incident-kind').forEach((b) => b.classList.remove('selected'));
  document.getElementById('incidentStatus').textContent = '';
  document.getElementById('submitIncident').disabled = true;
  document.getElementById('incidentCoords').textContent =
    `${pendingPoint.lat.toFixed(5)}, ${pendingPoint.lng.toFixed(5)}`;
  openSheet('incidentSheet');
});

document.querySelectorAll('#incidentKinds .incident-kind').forEach((btn) => {
  btn.addEventListener('click', () => {
    pendingIncidentKind = btn.dataset.incident;
    document.querySelectorAll('#incidentKinds .incident-kind').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('submitIncident').disabled = false;
  });
});

// One press must never become several reports. Found in production data rather than by reading the
// code: twelve identical assault reports at one coordinate, 400ms apart, from a single attempt.
// Nothing stopped the button firing again while the first insert was still in flight, and for this
// app that is not a duplicate row — it is twelve public accusations about a real address.
let incidentSubmitInFlight = false;

document.getElementById('submitIncident').addEventListener('click', guarded('incidentStatus', async () => {
  const statusEl = document.getElementById('incidentStatus');
  if (incidentSubmitInFlight) return;
  if (!pendingIncidentKind || !pendingPoint) return;
  if (!requireAccount('to report something that happened')) return;
  if (!sb) { statusEl.textContent = 'You need a connection to report an incident.'; return; }

  // Belt and braces: the flag stops a second handler run, disabling stops the tap reaching it at
  // all. Both, because the flag alone still leaves a button that looks pressable and is not.
  incidentSubmitInFlight = true;
  document.getElementById('submitIncident').disabled = true;
  setLoadingStatus(statusEl, 'Reporting…');
  // What, where and when — there is no free-text field, deliberately. See migration 022.
  const { error } = await settled(sb.from('incidents').insert({
    user_id: currentUser.id,
    category: pendingIncidentKind,
    lat: pendingPoint.lat,
    lng: pendingPoint.lng,
  }), 'report that');

  incidentSubmitInFlight = false;

  if (error) {
    // Only on failure does the button come back — on success the sheet closes, and re-enabling it
    // first would offer a second press for a report that has already been filed.
    document.getElementById('submitIncident').disabled = false;
    // The cooldown is enforced by row-level security, so a suspended account gets a bare policy
    // violation. Translate it rather than leaving somebody staring at Postgres.
    statusEl.textContent = /row-level security|policy/i.test(error.message || '')
      ? 'Your reports are paused for now — see My Page for why.'
      : error.message;
    return;
  }

  pendingIncidentKind = null;
  pendingPoint = null;
  closeSheets();
  showToast('Reported. It stays on the map for seven days, and others can confirm or dispute it.', 5000);
  buzz();
  loadIncidents();
}));

// ---------- Viewing and disputing one ----------

function openIncidentView(id) {
  const inc = incidents.find((x) => x.id === id);
  if (!inc) return;
  activeIncidentId = id;

  document.getElementById('incidentViewTitle').textContent =
    INCIDENT_KINDS[inc.category]?.label || 'Reported incident';
  document.getElementById('incidentViewWhen').textContent =
    'Reported about ' + describeAge(Date.now() - new Date(inc.occurred_at).getTime()) + '.';

  const up = Number(inc.confirmed) || 0;
  const down = Number(inc.disputed) || 0;
  document.getElementById('incidentViewTally').textContent = up || down
    ? `${up} confirmed, ${down} disputed.`
    : 'Nobody else has weighed in yet.';

  // Distance decides how much a vote counts, and saying so beforehand is fairer than silently
  // discounting it — and stops the "were you there?" question reading as an accusation.
  const near = userLocation
    && haversine(userLocation.lat, userLocation.lng, inc.lat, inc.lng) <= INCIDENT_NEARBY_M;
  document.getElementById('incidentVoteHint').textContent = near
    ? 'You are here now, so your answer counts double.'
    : 'You are not near this spot, so your answer counts less than someone who is.';

  document.getElementById('incidentDeleteBtn').hidden = !inc.is_mine;
  openSheet('incidentViewSheet');
}

async function voteIncident(vote) {
  const inc = incidents.find((x) => x.id === activeIncidentId);
  if (!inc) return;
  if (!requireAccount('to confirm or dispute a report')) return;
  const near = !!userLocation
    && haversine(userLocation.lat, userLocation.lng, inc.lat, inc.lng) <= INCIDENT_NEARBY_M;

  const { error } = await settled(sb.from('incident_votes').upsert({
    incident_id: inc.id, user_id: currentUser.id, vote, nearby: near,
  }, { onConflict: 'incident_id,user_id' }), 'save your answer');

  if (error) { showToast('Could not save your answer: ' + error.message); return; }
  closeSheets();
  showToast(vote === 1 ? 'Thanks — recorded as confirmed.' : 'Thanks — recorded as disputed.');
  buzz();
  loadIncidents();
}

// Upsert makes a repeat harmless in the database, but it still fires a request per tap and can
// close the sheet under someone mid-press. One at a time.
const voteIncidentOnce = onceAtATime(voteIncident);
document.getElementById('incidentConfirmBtn').addEventListener('click', () => voteIncidentOnce(1));
document.getElementById('incidentDisputeBtn').addEventListener('click', () => voteIncidentOnce(-1));

document.getElementById('incidentDeleteBtn').addEventListener('click', async () => {
  const id = activeIncidentId;
  const ok = await showConfirm('Remove this report from the map for everyone?',
    { okLabel: 'Delete report', title: 'Delete your report?' });
  if (!ok) { openIncidentView(id); return; }
  const { error } = await settled(sb.from('incidents').delete().eq('id', id), 'delete that report');
  if (error) { showToast('Could not delete: ' + error.message); return; }
  showToast('Report deleted.');
  loadIncidents();
});

// Everything the route ranker treats as an event rather than an opinion: the police layer and user
// incident reports, in the shape geo.js expects. Police areas carry their own radius; a user report
// is a point and gets the default reach.
function routeHazardList() {
  const list = [];
  policeEvents.forEach((e) => {
    if (e.lat == null || e.lng == null) return;
    list.push({
      id: 'police-' + e.id, kind: 'police', lat: e.lat, lng: e.lng,
      radiusM: e.radius_m || 0,
      at: e.occurred_at ? new Date(e.occurred_at).getTime() : Date.now(),
    });
  });
  incidents.forEach((i) => {
    list.push({
      id: 'incident-' + i.id, kind: 'incident', lat: i.lat, lng: i.lng,
      confirmed: i.confirmed, disputed: i.disputed,
      at: i.occurred_at ? new Date(i.occurred_at).getTime() : Date.now(),
    });
  });
  return list;
}

// One sentence naming what was found, kept vague about severity and precise about source — a user
// report and a police report must never read alike.
function hazardSentence(h) {
  if (!h) return 'Something was reported near this route.';
  const when = h.at ? describeAge(Date.now() - h.at) : 'recently';
  return h.kind === 'police'
    ? `Police reported something here ${when}.`
    : `Someone using SafeWalk reported something here ${when}.`;
}

// ---------- Init ----------
renderAccountState();
// onAuthStateChange also fires on load and pulls the map in, but only once Supabase has finished
// restoring the stored session. This kicks the same fetch off immediately so the map isn't blank
// while that resolves; whichever lands second simply re-renders the same rows.
refreshPinsFromCloud();
renderPins();
locate(true);
loadLighting();
loadPoliceEvents();
loadIncidents();
// One fetch at startup used to be the whole story: a dropped connection meant no police layer and
// no proximity warning until the app was reopened, which on a walk home may be never.
setInterval(loadPoliceEvents, POLICE_REFRESH_MS);
// Theme first: ratingColor() reads tokens, so the very first renderPins() must already have them.
applyTheme(currentTheme());

// A shared link turns this same app into the watcher's page. Checked after the theme is applied,
// because the walker's marker is drawn with resolved token colours.
(function checkForWatchLink() {
  const token = new URLSearchParams(location.search).get('watch');
  // A malformed token would reach the database as a cast error rather than an empty result, so it
  // is checked here — and an unknown but well-formed one is answered with "nothing to follow",
  // exactly like an expired one.
  if (token && /^[0-9a-f-]{36}$/i.test(token)) enterWatchMode(token);
})();
// Captured before the Supabase client was built; said out loud here, once the app is on screen.
if (emailLinkError) {
  const expired = /expired|invalid|already/i.test(emailLinkError);
  setTimeout(() => showToast(
    expired
      ? 'That email link has expired or was already used. Ask for a new one from the sign-in screen.'
      : emailLinkError,
    6000,
  ), 900);
}
setTimeout(() => document.getElementById('mapHint').classList.add('hidden'), 6000);
// Re-check at fire time, not just at schedule time — if the user already dismissed onboarding, or
// is already mid-action (say, they tapped the map to rate a spot before this timer fired), don't
// yank a sheet out from under them. This was a real bug: the old version scheduled the timeout
// unconditionally and never rechecked, so it could clobber whatever the user had just opened.
if (!localStorage.getItem(ONBOARDED_KEY)) {
  setTimeout(() => {
    if (localStorage.getItem(ONBOARDED_KEY)) return;
    if (document.querySelector('.sheet.open')) return;
    startOnboarding();
  }, 400);
}

// Caches the app shell so a dropped connection degrades to "working on stale data" instead of a
// blank page. Map tiles and live APIs are untouched — see sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------- Auto-update ----------
// version.json is the single source of truth: bump the string in that one file on deploy, and every
// open copy of the app notices on its next check and reloads itself. Nothing else needs editing,
// so the version can't drift out of sync with a constant someone forgot to change.
//
// This exists because a service worker is deliberately sticky. The worker is network-first now, so
// a reload does fetch the new build — but a phone with the app left open may not reload for days,
// and would keep running an old build against a database that has moved on. That is exactly how a
// test pin ended up in localStorage instead of the server.
let knownVersion = null;
let updatePending = false;

function applyUpdateIfIdle() {
  if (!updatePending) return;
  // Never yank the page out from under someone mid-report — a half-typed note about a street that
  // frightened them is not something to discard for a version bump. Wait until the sheet is closed.
  if (document.querySelector('.sheet.open')) return;
  updatePending = false;
  showToast('Updating to the latest version…');
  setTimeout(() => location.reload(), 900);
}

async function checkForUpdate() {
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (!version) return;
    const label = document.getElementById('appVersion');
    if (label) label.textContent = version;
    if (knownVersion === null) { knownVersion = version; return; } // first look: just record it
    if (version === knownVersion) return;
    updatePending = true;
    applyUpdateIfIdle();
  } catch {
    // Offline, or the file is momentarily unreachable. Not worth surfacing — we check again later.
  }
}

checkForUpdate();
setInterval(checkForUpdate, 30 * 60 * 1000);
// Coming back to a backgrounded PWA is the moment an update is most likely to be waiting.
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });

window.addEventListener("offline", () => {
  // The banner carries the detail (how old the ratings are); this is just the moment it happened.
  showToast("You are offline. Ratings you already loaded still show; adding or voting needs a connection.");
});

// Coming back online should not require a reload to get current data again.
window.addEventListener("online", () => {
  showToast("Back online — refreshing ratings.");
  refreshPinsFromCloud({ force: true });
});

// Keep userLocation fresh in the background so the 1km rating-proximity check
// (and the SOS/route "my location" flows) reflect where the person actually is,
// not just where they were when the app first loaded.
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserMarker(userLocation.lat, userLocation.lng, pos.coords.accuracy);
      checkPoliceProximity();
      checkIncidentProximity();
    },
    () => { /* keep last known location on error */ },
    { enableHighAccuracy: true, maximumAge: 20000, timeout: 15000 }
  );
}
