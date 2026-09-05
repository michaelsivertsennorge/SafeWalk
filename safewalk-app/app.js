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
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function minDistanceToPaths(lat, lng, paths) {
  let min = Infinity;
  paths.forEach((path) => {
    path.forEach(([plat, plng]) => {
      const d = haversine(lat, lng, plat, plng);
      if (d < min) min = d;
    });
  });
  return min;
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
async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res.ok ? res : null;
  } catch {
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
async function fetchStreetNetwork(lat, lng, radius = 700) {
  const query = `[out:json][timeout:25];way(around:${radius},${lat},${lng})[highway][name];out geom;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(url, {}, 20000);
  if (!res) return null;
  const data = await res.json();
  const ways = (data.elements || []).filter(
    (el) => el.type === 'way' && el.geometry && el.tags && el.tags.name && !UNWALKABLE.has(el.tags.highway)
  );
  if (!ways.length) return null;
  return buildStreetGraph(ways);
}

// Nodes are keyed by exact coordinate. OpenStreetMap shares the identical node between ways that
// meet, so two streets crossing at a junction produce the same key and are joined automatically —
// including mid-way T-junctions, which endpoint matching always missed.
const nodeKey = (lat, lng) => `${lat.toFixed(7)},${lng.toFixed(7)}`;

function buildStreetGraph(ways) {
  const nodes = new Map(); // key -> { lat, lng, edges: [{ to, dist, name }] }
  const touch = (lat, lng) => {
    const k = nodeKey(lat, lng);
    if (!nodes.has(k)) nodes.set(k, { lat, lng, edges: [] });
    return k;
  };
  ways.forEach((w) => {
    const name = w.tags.name;
    for (let i = 1; i < w.geometry.length; i++) {
      const a = w.geometry[i - 1];
      const b = w.geometry[i];
      const ka = touch(a.lat, a.lon);
      const kb = touch(b.lat, b.lon);
      if (ka === kb) continue;
      const d = haversine(a.lat, a.lon, b.lat, b.lon);
      // Undirected: every street is walkable both ways, whatever its driving direction.
      nodes.get(ka).edges.push({ to: kb, dist: d, name });
      nodes.get(kb).edges.push({ to: ka, dist: d, name });
    }
  });
  return { nodes };
}

function nearestGraphNode(graph, lat, lng, maxDist = 80) {
  let bestKey = null;
  let bestDist = Infinity;
  graph.nodes.forEach((n, k) => {
    const d = haversine(lat, lng, n.lat, n.lng);
    if (d < bestDist) { bestDist = d; bestKey = k; }
  });
  return bestDist <= maxDist ? bestKey : null;
}

// Plain Dijkstra. These graphs are a few hundred nodes, so a sorted-array frontier is quicker in
// practice than the bookkeeping a heap would cost.
function shortestStreetPath(graph, fromKey, toKey) {
  if (fromKey === toKey) return { keys: [fromKey], names: [] };
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map();
  const visited = new Set();
  const frontier = [{ key: fromKey, d: 0 }];

  while (frontier.length) {
    frontier.sort((a, b) => a.d - b.d);
    const { key } = frontier.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    if (key === toKey) break;
    const node = graph.nodes.get(key);
    if (!node) continue;
    node.edges.forEach((e) => {
      if (visited.has(e.to)) return;
      const nd = dist.get(key) + e.dist;
      if (nd < (dist.has(e.to) ? dist.get(e.to) : Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: key, name: e.name });
        frontier.push({ key: e.to, d: nd });
      }
    });
  }
  if (!dist.has(toKey)) return null; // the two points aren't connected by walkable streets

  const keys = [];
  const names = [];
  let cur = toKey;
  while (cur !== fromKey) {
    const step = prev.get(cur);
    if (!step) return null;
    keys.push(cur);
    names.push(step.name);
    cur = step.from;
  }
  keys.push(fromKey);
  return { keys: keys.reverse(), names: names.reverse() };
}

// Only people who are actually near a street can rate it — keeps ratings grounded in lived experience
// instead of remote drive-by trolling.
const RATING_RADIUS_M = 1000;
function withinRatingRange(lat, lng) {
  return !!userLocation && haversine(userLocation.lat, userLocation.lng, lat, lng) <= RATING_RADIUS_M;
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

// Three fixed bands instead of a continuous gradient: >75% safe reads unambiguously as safe,
// <50% safe (i.e. more than half unsafe reports) reads unambiguously as unsafe, and the wide
// middle ground where opinion is genuinely split shows as a distinct "mixed" color rather than
// a shade that could be misread either way.
function ratingBand(ratio) {
  if (ratio > 0.75) return 'safe';
  if (ratio < 0.5) return 'danger';
  return 'mixed';
}
function ratingColor(ratio) {
  const band = ratingBand(ratio);
  if (band === 'safe') return '#10b981';
  if (band === 'danger') return '#f43f5e';
  return '#f5c945';
}

// Color alone (red/yellow/green) is one of the least accessible combinations for colorblind users,
// so every rated shape also gets a distinct line style — solid/dashed/dotted reads the same regardless
// of how the color itself is perceived.
function ratingDash(ratio) {
  const band = ratingBand(ratio);
  if (band === 'safe') return null;
  if (band === 'mixed') return '7 5';
  return '2 5';
}

// ---------- Map setup ----------
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

function parseWktLineStringZ(wkt) {
  // NVDB returns "LINESTRING Z(lat lon z, lat lon z, ...)" when requested with srid=4326.
  const inner = wkt.slice(wkt.indexOf('(') + 1, wkt.lastIndexOf(')'));
  return inner.split(',').map((triplet) => {
    const [lat, lon] = triplet.trim().split(/\s+/).map(Number);
    return [lat, lon];
  });
}

async function loadLighting() {
  if (map.getZoom() < 14) return; // avoid slow, huge queries when zoomed out
  const b = map.getBounds();
  const key = boundsKey(b);
  if (key === lightingLoadedFor) return;
  lightingLoadedFor = key;
  const bbox = `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
  try {
    const url = `https://nvdbapiles-v3.atlas.vegvesen.no/vegobjekter/86?kartutsnitt=${bbox}&srid=4326&inkluder=geometri&antall=1000`;
    const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } });
    if (!res) return;
    const data = await res.json();
    lightingLayer.clearLayers();
    (data.objekter || []).forEach((obj) => {
      const wkt = obj.geometri && obj.geometri.wkt;
      if (!wkt || !wkt.startsWith('LINESTRING')) return;
      L.polyline(parseWktLineStringZ(wkt), {
        color: '#facc15',
        weight: 3,
        opacity: 0.5,
        interactive: false,
      }).addTo(lightingLayer);
    });
  } catch {
    /* supplementary layer — ignore failures */
  }
}
map.on('moveend', loadLighting);

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
        color: '#4a9eff',
        weight: 1,
        fillColor: '#4a9eff',
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
    color: '#f5c945',
    weight: 2,
    dashArray: '4 5',
    fillColor: '#f5c945',
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
        updateUserMarker(userLocation.lat, userLocation.lng, pos.coords.accuracy);
        if (recenter) map.setView([userLocation.lat, userLocation.lng], 16);
        renderPins();
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
  requestAnimationFrame(() => sheet.focus());
}
function closeSheets() {
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
backdrop.addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.sheet.open')) closeSheets();
});

document.getElementById('confirmCancelBtn').addEventListener('click', () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(false);
});
document.getElementById('confirmOkBtn').addEventListener('click', () => {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(true);
});

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
      streetLookupStatus.textContent = "Couldn't find named streets here — try a spot closer to a road.";
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
      fillColor: i === 0 ? '#4ade80' : '#8b7bff',
      fillOpacity: 1, interactive: false,
    }).addTo(trimState.dotLayer);
  });

  const hint = document.getElementById('trimHint');
  const undoBtn = document.getElementById('trimUndoBtn');
  const doneBtn = document.getElementById('trimDoneBtn');
  if (!waypoints.length) {
    hint.textContent = 'Tap where the stretch starts.';
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
function startStreetPicker(graph, seedLat, seedLng, existingPath) {
  closeSheets();
  const activeLine = L.polyline([], { color: '#8b7bff', weight: 7, opacity: 0.95, interactive: false }).addTo(map);
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
  leg.names.forEach((n) => trimState.streetNames.add(n));
  trimState.legLengths = trimState.legLengths || [];
  trimState.legLengths.push(pts.length - 1);
  redrawTrimActive();
  return true;
}

// A tap while the picker is open: snap to the nearest street node and extend the chain.
function handleStreetPick(lat, lng) {
  const key = nearestGraphNode(trimState.graph, lat, lng, 60);
  if (!key) {
    showToast('No street there — tap closer to a road.');
    return;
  }
  if (!trimState.waypoints.length) {
    trimState.waypoints = [key];
    redrawTrimActive();
    buzz();
    return;
  }
  if (!addWaypoint(key)) {
    showToast("Can't reach that street on foot from here — try a point in between.");
    return;
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
    if (leg) leg.names.forEach((n) => trimState.streetNames.add(n));
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

document.getElementById('pinRedragBtn').addEventListener('click', async () => {
  const p = pins.find((x) => x.id === activePinId);
  if (!p || !p.paths) return;
  if (!requireAccount('to change a street you marked')) return;
  const pinId = p.id;
  closeSheets();
  showToast('Loading nearby streets…');
  const graph = await fetchStreetNetwork(p.lat, p.lng);
  if (!graph) {
    showToast("Couldn't look up nearby streets right now — try again in a moment.");
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
    notes: [], // additional community notes (route feedback, etc.) accumulate here
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
  const inRange = withinRatingRange(p.lat, p.lng);
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
  document.getElementById('pinRedragBtn').hidden = !(p.own && p.paths);
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
    if (!withinRatingRange(p.lat, p.lng)) {
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
  if (!res) return null;
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
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

function routeSafetyScore(coords) {
  // coords: [[lat,lng], ...]
  const nearbyPins = new Set();
  let score = 0;
  const sampleEvery = Math.max(1, Math.floor(coords.length / 40));
  for (let i = 0; i < coords.length; i += sampleEvery) {
    const [lat, lng] = coords[i];
    pins.forEach((p) => {
      if (nearbyPins.has(p.id)) return;
      // A street/area pin's danger zone extends along its whole shape, not just its stored
      // midpoint — a route passing close to one end of a long marked street must still count.
      const dist = p.paths ? minDistanceToPaths(lat, lng, p.paths) : haversine(lat, lng, p.lat, p.lng);
      const threshold = Math.max(60, p.radius || 0);
      if (dist <= threshold) {
        nearbyPins.add(p.id);
        score += p.safe - p.danger * 1.5;
      }
    });
  }
  return { score, pinsNearby: nearbyPins.size };
}

// Decodes a Valhalla-encoded polyline (Google polyline algorithm, 6-decimal precision) into [lat,lng] pairs.
function decodePolyline(encoded, precision = 6) {
  let index = 0, lat = 0, lng = 0;
  const factor = Math.pow(10, precision);
  const coordinates = [];
  while (index < encoded.length) {
    let result = 1, shift = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1; shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

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
  for (let i = 0; i < activeRouteCoords.length; i += step) {
    const [lat, lng] = activeRouteCoords[i];
    const nearby = findNearbyPin(lat, lng, 60);
    if (nearby) {
      if (touched.has(nearby.id)) continue;
      touched.add(nearby.id);
      if ((nearby.voters || []).includes(voterId)) { skippedAlreadyVoted++; continue; }
      if (rating === 'safe') nearby.safe++; else nearby.danger++;
      if (note) nearby.notes.push({ text: note, rating });
      nearby.voters = [...(nearby.voters || []), voterId];
      persistVote(nearby.id, rating);
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
  renderPins();
  selectedRouteFeedbackRating = null;
  document.querySelectorAll('#routeFeedback [data-route-rating]').forEach((b) => b.classList.remove('selected'));
  document.getElementById('routeFeedbackNote').value = '';
  submitRouteFeedbackBtn.disabled = true;
  const skippedNote = skippedAlreadyVoted ? ` (${skippedAlreadyVoted} spot${skippedAlreadyVoted === 1 ? '' : 's'} skipped — already rated by you)` : '';
  showToast(`Thanks — added to ${affected} street rating${affected === 1 ? '' : 's'} along that route${skippedNote}.`);
  buzz();
});

document.getElementById('findRouteBtn').addEventListener('click', async () => {
  const status = document.getElementById('routeStatus');
  const resultsEl = document.getElementById('routeResults');
  resultsEl.innerHTML = '';
  routeLayer.clearLayers();
  setLoadingStatus(status, 'Locating your route…');
  activeRouteCoords = null;
  routeFeedbackEl.hidden = true;
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
        fromPoint = await geocode(fromText);
        if (!fromPoint) throw new Error(`Couldn't find "${fromText}". Try adding a city name, or tap 📍 to pick it on the map instead.`);
      }
    }

    let toPoint;
    if (routePins.to) {
      toPoint = routePins.to;
    } else {
      const toText = document.getElementById('routeTo').value.trim();
      if (!toText) throw new Error('Enter a destination, or tap 📍 next to "To" to pick one on the map.');
      setLoadingStatus(status, 'Finding destination…');
      toPoint = await geocode(toText);
      if (!toPoint) throw new Error(`Couldn't find "${toText}". Try adding a city name, or tap 📍 to pick it on the map instead.`);
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
    if (!res) throw new Error('The routing service is taking too long to respond. Try again in a moment.');
    const data = await res.json();
    if (!data.trip) throw new Error(`No ${modeLabel} route found between those points.`);

    const trips = [data.trip, ...(data.alternates || []).map((a) => a.trip)];
    const scored = trips.map((trip) => {
      const coords = trip.legs.flatMap((leg) => decodePolyline(leg.shape, 6));
      const { score, pinsNearby } = routeSafetyScore(coords);
      return { coords, distanceKm: trip.summary.length, durationSec: trip.summary.time, score, pinsNearby };
    });
    scored.sort((a, b) => b.score - a.score);

    status.textContent = `${scored.length} route${scored.length > 1 ? 's' : ''} compared using ${pins.length} community report${pins.length === 1 ? '' : 's'}.`;

    const entries = [];
    scored.forEach((r, rank) => {
      const isBest = rank === 0;
      const poly = L.polyline(r.coords, { color: '#5b5d94', weight: 4, opacity: 0.55 }).addTo(routeLayer);

      const mins = Math.round(r.durationSec / 60);
      const km = r.distanceKm.toFixed(2);
      const card = document.createElement('div');
      card.className = 'route-card';
      card.innerHTML = `
        <div class="route-card-top">
          <span>Route ${rank + 1}</span>
          ${isBest ? '<span class="route-badge">SAFEST</span>' : ''}
        </div>
        <div class="route-meta">${km} km · ~${mins} min ${modeLabel} · ${r.pinsNearby} nearby report${r.pinsNearby === 1 ? '' : 's'}</div>
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
          color: active ? '#8b7bff' : '#5b5d94',
          weight: active ? 6 : 4,
          opacity: active ? 0.95 : 0.55,
        });
        if (active) e.poly.bringToFront();
        e.card.classList.toggle('selected', active);
        e.statusLabel.textContent = active ? 'Showing on map ✓' : 'Tap to show this route on the map';
      });
      activeRouteCoords = entries[rank].coords;
      routeFeedbackEl.hidden = false;
      if (fitView) {
        if (!keepSheetOpen) closeSheets();
        map.fitBounds(entries[rank].poly.getBounds(), { padding: [40, 40] });
      }
    }

    entries.forEach((e) => {
      e.card.addEventListener('click', () => selectRoute(e.rank));
      e.poly.on('click', () => selectRoute(e.rank, { keepSheetOpen: true }));
    });

    if (entries.length) selectRoute(0, { fitView: true, keepSheetOpen: true });
  } catch (err) {
    status.textContent = typeof err.message === 'string' && err.message
      ? err.message
      : 'Something went wrong finding that route. Check your connection and try again.';
  }
});

// ---------- SOS ----------
// A web page can never silently place a call — it always requires the user's own confirmation.
// So the flow here is deliberately just two steps: confirm, then call your one emergency contact.
document.getElementById('sosBtn').addEventListener('click', async () => {
  cancelPicking();
  const contact = contacts[0];
  if (!contact || !contact.phone) {
    showToast('Add your emergency contact first (profile icon) so SOS knows who to call.');
    renderContacts();
    openSheet('settingsSheet');
    return;
  }
  const ok = await showConfirm(`Call ${contact.name} now?`, { okLabel: 'Call now', title: 'Are you sure?' });
  if (!ok) return;
  buzz();
  window.location.href = `tel:${contact.phone}`;
});

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

document.getElementById('settingsBtn').addEventListener('click', () => {
  cancelPicking();
  renderContacts();
  applyDarkMapPref();
  openSheet('settingsSheet');
});

// Only one emergency contact — SOS calls them directly, so there's no list to manage, just
// "who is it" and a way to replace them.
function renderContacts() {
  const list = document.getElementById('contactList');
  const showFormBtn = document.getElementById('showContactFormBtn');
  list.innerHTML = '';
  if (!contacts.length) {
    showFormBtn.hidden = false;
    return;
  }
  showFormBtn.hidden = true;
  const c = contacts[0];
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `<span>${c.name} · ${c.phone}</span>`;
  const rm = document.createElement('button');
  rm.textContent = 'Remove';
  rm.addEventListener('click', () => {
    contacts = [];
    saveContacts(contacts);
    renderContacts();
  });
  row.appendChild(rm);
  list.appendChild(row);
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
  contacts = [{ name, phone }]; // replaces any existing contact — there's only ever one
  saveContacts(contacts);
  document.getElementById('contactName').value = '';
  document.getElementById('contactPhone').value = '';
  document.getElementById('contactForm').hidden = true;
  renderContacts();
});

document.getElementById('clearDataBtn').addEventListener('click', async () => {
  // Deliberately scoped to this device. Your ratings belong to your account and stay there — the
  // place to remove those is My marks, one at a time, so this button can't quietly wipe the map.
  const ok = await showConfirm(
    'Clear your emergency contact and app settings on this device? Your ratings stay on your account.',
    { okLabel: 'Clear device data', title: 'Clear data on this device?' }
  );
  if (!ok) return;
  localStorage.removeItem(CONTACTS_KEY);
  localStorage.removeItem(ONBOARDED_KEY);
  localStorage.removeItem(DARK_MAP_KEY);
  location.reload();
});

// ---------- My reports & marks (view / edit / delete what you've added) ----------
document.getElementById('myReportsBtn').addEventListener('click', () => {
  renderMyReports();
  openSheet('myReportsSheet');
});

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
    list.innerHTML = currentUser
      ? '<p class="sheet-sub">You haven’t added any ratings yet — tap the map to rate a spot, or press and hold to mark an area.</p>'
      : '<p class="sheet-sub">Sign in to start adding ratings. They’ll follow your account, so they show up on every device you use.</p>';
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
  // When a write action sent us here, lead with what the sign-in is actually for.
  document.getElementById('authStatus').textContent = authReason ? `Sign in ${authReason}.` : '';
}

document.getElementById('accountActionBtn').addEventListener('click', async () => {
  if (!sb) return showToast('Cloud sync is unavailable — check your connection.');
  if (currentUser) {
    const ok = await showConfirm("Your ratings stay in your account. You'll still see the map, but you won't be able to add to it until you sign back in.", { okLabel: 'Sign out', title: 'Sign out?' });
    if (!ok) { openSheet('settingsSheet'); return; }
    await sb.auth.signOut();
    showToast('Signed out.');
    openSheet('settingsSheet');
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

document.getElementById('authSubmitBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const statusEl = document.getElementById('authStatus');
  if (!email || !password) { statusEl.textContent = 'Enter your email and password.'; return; }

  setLoadingStatus(statusEl, authMode === 'signin' ? 'Signing in…' : 'Creating your account…');
  const { data, error } = authMode === 'signin'
    ? await sb.auth.signInWithPassword({ email, password })
    : await sb.auth.signUp({ email, password });

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
});

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
    notes: [],
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
async function refreshPinsFromCloud() {
  if (!sb) return;
  const [{ data: rows, error }, { data: myVotes }] = await Promise.all([
    sb.from('pins_with_scores').select('*'),
    currentUser
      ? sb.from('votes').select('pin_id').eq('user_id', currentUser.id)
      : Promise.resolve({ data: [] }),
  ]);
  if (error) {
    showToast("Couldn't load the safety map — check your connection.");
    return;
  }
  const votedIds = new Set((myVotes || []).map((v) => v.pin_id));
  pins = (rows || []).map((r) => rowToPin(r, votedIds));
  renderPins();
  renderMyReports();
}

// Every mutation goes through these. They're only reached past requireAccount(), so an unsigned
// call is a bug rather than a state to handle gracefully — hence the hard guard.
async function persistCreate(pin) {
  if (!currentUser) return;
  const { data, error } = await sb.from('pins').insert(pinToRow(pin)).select('id').single();
  if (error) { showToast('Could not save to your account: ' + error.message); return; }
  pin.id = data.id; // swap the local temp id for the real one
  await sb.from('votes').insert({ pin_id: pin.id, user_id: currentUser.id, rating: pin.creatorRating });
}

async function persistUpdate(pin) {
  if (!currentUser) return;
  const { error } = await sb.from('pins').update({
    lat: pin.lat, lng: pin.lng, radius_m: pin.radius || null, path: pin.paths || null,
    street_name: pin.streetName || null, creator_rating: pin.creatorRating,
    creator_note: pin.creatorNote || null,
  }).eq('id', pin.id);
  if (error) { showToast('Could not save changes: ' + error.message); return; }
  await sb.from('votes').update({ rating: pin.creatorRating }).eq('pin_id', pin.id).eq('user_id', currentUser.id);
}

async function persistDelete(id) {
  if (!currentUser) return;
  const { error } = await sb.from('pins').delete().eq('id', id);
  if (error) showToast('Could not delete: ' + error.message);
}

async function persistVote(pinId, rating) {
  if (!currentUser) return;
  // The (pin_id, user_id) primary key is what actually guarantees one vote per person here.
  const { error } = await sb.from('votes').insert({ pin_id: pinId, user_id: currentUser.id, rating });
  if (error) showToast(error.message.includes('duplicate') ? "You've already rated this spot." : 'Could not save your vote.');
}

if (sb) {
  // Fires on load with the restored session too, so this is also how the map gets its first fill.
  sb.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session ? session.user : null;
    renderAccountState();
    await refreshPinsFromCloud();
  });
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
applyDarkMapPref();
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

window.addEventListener('offline', () => showToast("You're offline — showing your last saved data. Live maps, routes, and lookups need a connection."));
window.addEventListener('online', () => showToast('Back online.'));

// Keep userLocation fresh in the background so the 1km rating-proximity check
// (and the SOS/route "my location" flows) reflect where the person actually is,
// not just where they were when the app first loaded.
if (navigator.geolocation) {
  navigator.geolocation.watchPosition(
    (pos) => {
      userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserMarker(userLocation.lat, userLocation.lng, pos.coords.accuracy);
    },
    () => { /* keep last known location on error */ },
    { enableHighAccuracy: true, maximumAge: 20000, timeout: 15000 }
  );
}
