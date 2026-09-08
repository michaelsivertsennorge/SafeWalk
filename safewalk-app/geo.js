// SafeWalk — pure geometry and graph maths.
//
// Split out of app.js so it can be tested without a browser, a map, or a network. Everything here
// is a pure function of its arguments: no DOM, no globals, no fetch. This is the code where a
// silent error would make the app lie about whether a street is safe, so it is the code that most
// needs tests. See tests/geo.test.js — run it with `node tests/geo.test.js`.

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
// The nearest point on a set of polylines, measured to the SEGMENTS rather than only to the
// vertices they are drawn between. Returns { lat, lng, dist } in metres, or null if there is no
// usable geometry.
//
// Two separate faults came from only ever looking at vertices. OpenStreetMap draws a straight
// street as its endpoints and nothing in between — the longest such gap measured in central Oslo
// is 118m, on Grønland — so standing in the middle of one read as up to 59m away, right at the
// 60m threshold routeSafetyScore uses to decide whether a marked street counts against a route.
// And "Near me" had no such point to aim at, so it drew its compass arrow towards the pin's
// stored midpoint instead. Replayed over 500m of real central Oslo geometry, that named the
// wrong compass direction in 80 of 94 chained selections; the worst pointed 176° out, calling a
// street you were standing on "151m south" when it was north of you.
//
// Over a few hundred metres the sphere can be flattened onto a local plane scaled by
// cos(latitude) to find the closest point; the error is far below a metre. The distance itself is
// then measured with haversine, so every distance in the app still comes from the same formula.
function nearestPointOnPaths(lat, lng, paths) {
  if (!Array.isArray(paths) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const mPerDegLat = 111320;
  // Guarded so a longitude at the poles cannot divide by zero. Meaningless there, but finite.
  const mPerDegLng = Math.max(1e-6, 111320 * Math.cos((lat * Math.PI) / 180));

  let best = null;
  const consider = (p, q) => {
    const px = (p[1] - lng) * mPerDegLng, py = (p[0] - lat) * mPerDegLat;
    const qx = (q[1] - lng) * mPerDegLng, qy = (q[0] - lat) * mPerDegLat;
    const dx = qx - px, dy = qy - py;
    const len2 = dx * dx + dy * dy;
    // How far along the segment the closest point falls, clamped so it cannot slide off an end.
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(px * dx + py * dy) / len2)) : 0;
    const cx = px + t * dx, cy = py + t * dy;
    const d2 = cx * cx + cy * cy;
    if (best && d2 >= best.d2) return;
    best = { d2, lat: lat + cy / mPerDegLat, lng: lng + cx / mPerDegLng };
  };

  paths.forEach((path) => {
    if (!Array.isArray(path)) return;
    const pts = path.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return;
    if (pts.length === 1) { consider(pts[0], pts[0]); return; }
    for (let i = 0; i < pts.length - 1; i++) consider(pts[i], pts[i + 1]);
  });

  if (!best) return null;
  return { lat: best.lat, lng: best.lng, dist: haversine(lat, lng, best.lat, best.lng) };
}
function minDistanceToPaths(lat, lng, paths) {
  const near = nearestPointOnPaths(lat, lng, paths);
  return near ? near.dist : Infinity;
}
const nodeKey = (lat, lng) => `${lat.toFixed(7)},${lng.toFixed(7)}`;
function buildStreetGraph(ways) {
  const graph = { nodes: new Map(), wayIds: new Set() };
  mergeWaysIntoGraph(graph, ways);
  return graph;
}

// Adds ways to an existing graph. Used by the background widen: the picker stays usable on the
// small fast network while the larger one arrives and is folded in underneath, with no rebuild and
// no loss of whatever the user has already tapped.
function mergeWaysIntoGraph(graph, ways) {
  const nodes = graph.nodes;
  const touch = (lat, lng) => {
    const k = nodeKey(lat, lng);
    if (!nodes.has(k)) nodes.set(k, { lat, lng, edges: [] });
    return k;
  };
  let added = 0;
  ways.forEach((w) => {
    if (w.id != null) {
      if (graph.wayIds.has(w.id)) return; // already merged; re-adding would duplicate every edge
      graph.wayIds.add(w.id);
    }
    added++;
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
  return added;
}

function nearestGraphNode(graph, lat, lng, maxDist = 80, allowed = null) {
  let bestKey = null;
  let bestDist = Infinity;
  graph.nodes.forEach((n, k) => {
    if (allowed && !allowed.has(k)) return;
    const d = haversine(lat, lng, n.lat, n.lng);
    if (d < bestDist) { bestDist = d; bestKey = k; }
  });
  return bestDist <= maxDist ? bestKey : null;
}

// Every node walkable from `key`. Overpass cuts ways at the edge of the query circle, so a chunk of
// what it returns is stranded: measured here, 12% of nodes sat in 12 fragments disconnected from
// the main network. Snapping a tap to the nearest node overall could therefore land on a street
// that is unreachable, and the user would get "can't reach that" while looking at a map where the
// two streets plainly join. Restricting the snap to reachable nodes avoids the whole class of
// confusing failure.
function reachableFrom(graph, key) {
  const seen = new Set([key]);
  const stack = [key];
  while (stack.length) {
    const node = graph.nodes.get(stack.pop());
    if (!node) continue;
    node.edges.forEach((e) => {
      if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    });
  }
  return seen;
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

function ratingBand(ratio) {
  if (ratio > 0.75) return 'safe';
  if (ratio < 0.5) return 'danger';
  return 'mixed';
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


// ---------- Colour contrast ----------
// Lives here, with tests, because it is the thing standing between a custom accent colour and an
// app the person who chose it cannot read. A theme picker that lets someone make their own safety
// app illegible is a bug, not a preference.

function hexToRgb(hex) {
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
}

// WCAG relative luminance.
function relativeLuminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio, 1..21. Order of arguments does not matter.
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Given a background, return the app's dark or light ink — whichever is more readable on it.
// Any colour has at least 4.5:1 against one of the two, so this always returns something usable.
const INK_DARK = '#14103a';
const INK_LIGHT = '#ffffff';
function pickReadableInk(bg) {
  const onDark = contrastRatio(INK_DARK, bg);
  const onLight = contrastRatio(INK_LIGHT, bg);
  if (onDark === null || onLight === null) return INK_LIGHT;
  return onDark >= onLight ? INK_DARK : INK_LIGHT;
}

// How safe a route looks, per kilometre, given what people have reported near it.
//
// The previous version summed `p.safe - p.danger * 1.5` in raw votes, which was wrong in three
// ways that all pointed the same direction — towards calling a route "safest" when it wasn't:
//
//   1. Raw counts meant one popular pin with 20 safe votes buried every other signal on the route.
//   2. Nothing was normalised by length, so a long route collected more score simply by being
//      long. "Safest" could quietly mean "longest".
//   3. A route with no reports at all scored 0 and could still be badged SAFEST, presenting the
//      absence of evidence as evidence of safety. For an app someone consults before walking home
//      alone, that is the worst possible failure mode.
//
// Now each pin contributes its *lean* (how one-sided its votes are, -1..+1) scaled by a confidence
// factor, danger weighted more heavily than safety, and the total is divided by route length.
// `coverage` reports how much of the route anyone has actually said anything about, so the UI can
// tell "reported safe" apart from "nobody knows".
// `allPins` is passed in rather than read from a global so this can be tested without a browser.
function routeSafetyScore(coords, distanceKm, allPins) {
  const nearbyPins = new Set();
  let score = 0;
  let safePins = 0;
  let dangerPins = 0;
  let sampled = 0;
  let sampledWithData = 0;

  const sampleEvery = Math.max(1, Math.floor(coords.length / 40));
  for (let i = 0; i < coords.length; i += sampleEvery) {
    const [lat, lng] = coords[i];
    sampled++;
    let anyHere = false;
    allPins.forEach((p) => {
      // A street/area pin's zone extends along its whole shape, not just its stored midpoint — a
      // route passing close to one end of a long marked street must still count.
      const dist = p.paths ? minDistanceToPaths(lat, lng, p.paths) : haversine(lat, lng, p.lat, p.lng);
      const threshold = Math.max(60, p.radius || 0);
      if (dist > threshold) return;
      anyHere = true;
      if (nearbyPins.has(p.id)) return;
      nearbyPins.add(p.id);

      const total = p.safe + p.danger;
      if (!total) return;
      const lean = (p.safe / total - 0.5) * 2;          // -1 (all unsafe) .. +1 (all safe)
      const confidence = Math.min(1, total / 4);         // one lone vote is not four votes
      // A warning deserves more weight than a reassurance here: the cost of ignoring a real danger
      // is far higher than the cost of avoiding a street that turned out to be fine.
      score += (lean < 0 ? lean * 1.5 : lean) * confidence;
      if (lean < 0) dangerPins++; else safePins++;
    });
    if (anyHere) sampledWithData++;
  }

  return {
    score: score / Math.max(0.2, distanceKm || 0.2), // per kilometre, so length can't inflate it
    pinsNearby: nearbyPins.size,
    coverage: sampled ? sampledWithData / sampled : 0,
    safePins,
    dangerPins,
  };
}

// Which claim the app is entitled to make about the route it puts first. This is the single most
// consequential sentence the product produces — someone decides which way to walk home on it — and
// it used to live inside the render function, reading globals, where it could not be tested. It was
// wrong for a long time as a result: the "every route is flagged" case fell through to "AVOIDS
// FLAGGED STREETS", so the recommended card claimed to avoid warnings while displaying its own.
//
// Takes routes already sorted by score, best first, and answers only what the evidence supports:
//   'safest'    — the winning route itself carries positive reports.
//   'avoids'    — it won because others carry warnings and it carries none.
//   'leastBad'  — every route has somewhere reported unsafe; this one merely ranks best.
//   'shortest'  — no usable evidence; the caller should rank by distance instead.
//
// `hasFewest` is reported rather than assumed. Routes are ordered by score, not by how many
// warnings they carry, so the best-scoring route is not automatically the least flagged, and
// "fewest warnings" would be a false claim in that case.
function routeRankingClaim(scored) {
  if (!Array.isArray(scored) || !scored.length) return { kind: 'shortest', haveEvidence: false };
  const best = scored[0];
  const worst = scored[scored.length - 1];
  const anyReports = scored.some((r) => r.pinsNearby > 0);
  // One route cannot be compared against anything, so any report on it counts as evidence. With
  // several, the scores must actually differ, or "safest" is just noise between equals.
  const spread = best.score - worst.score;
  const haveEvidence = anyReports && (scored.length === 1 || spread > 0.15);

  if (!haveEvidence) return { kind: 'shortest', haveEvidence: false };
  if (best.pinsNearby > 0 && best.score > 0) return { kind: 'safest', haveEvidence: true };
  if (!best.dangerPins) return { kind: 'avoids', haveEvidence: true };
  return {
    kind: 'leastBad',
    haveEvidence: true,
    dangerPins: best.dangerPins,
    hasFewest: scored.every((r) => r.dangerPins >= best.dangerPins),
  };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// Nudge a colour's lightness until its best ink clears `minRatio`, keeping the hue the person
// chose. Necessary because picking the better ink is not always enough: a sweep of 540 colours
// found 12 mid-tone ones — olive #7d7d36, steel blue #4d80b3 — where neither dark nor light ink
// reaches 4.5:1. Rather than refuse their colour or ship an unreadable button, shift it the
// smallest distance that works, in whichever direction gets there first.
function adjustForContrast(hex, minRatio = 4.5) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const best = (c) => Math.max(contrastRatio(INK_DARK, c), contrastRatio(INK_LIGHT, c));
  if (best(hex) >= minRatio) return hex;

  const [h, s, l0] = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  for (let step = 0.01; step <= 1; step += 0.01) {
    for (const l of [l0 + step, l0 - step]) {
      if (l < 0 || l > 1) continue;
      const cand = hslToHex(h, s, l);
      if (best(cand) >= minRatio) return cand;
    }
  }
  return hex; // unreachable in practice: black and white both satisfy any ratio below 21
}

// ---------- Direction in words ----------
// The map is the whole product and it has no non-visual equivalent: "which streets near me are
// marked unsafe" is currently answerable only by looking. Distance alone does not help — "180m
// away" could be behind you. A compass point turns a pin into something you can act on without
// looking at a screen, which matters both for screen-reader users and for anyone walking at night
// who would rather not stare at a phone.

// Initial bearing from one point to another, in degrees clockwise from north.
function bearingDegrees(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1), φ2 = toRad(lat2), Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS_POINTS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

// Eight points is the right granularity for spoken directions: sixteen would be more precise than
// anyone can act on while walking, and four is too coarse to distinguish two nearby streets.
function compassPoint(deg) {
  if (!Number.isFinite(deg)) return null;
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[i];
}

// Distance phrased the way a person would say it, not to the metre.
function describeDistance(m) {
  if (!Number.isFinite(m)) return null;
  if (m < 20) return 'right here';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// How long ago something happened, in the words a person actually uses. Police reports live only
// 6-24 hours, so every one of them is "Today" to a day-granularity formatter — useless for the
// only question being asked of them, which is whether this is happening right now or is over.
// Minutes below an hour, hours below a day; nothing finer, because the sync runs hourly and
// pretending to second-level freshness would be a lie about how current the data is.
function describeAge(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 0) return 'just now';               // clock skew between phone and server
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

// ---------- PostGIS geometry, as it arrives over the REST API ----------
// PostgREST hands geography columns back as hex EWKB. Only points are ever read here — police
// incidents — so this parses that one case rather than pulling in a full WKB library.
//
// It reads the header instead of assuming a layout, because the first version did assume one and
// was wrong in three of four real encodings. Against fixtures generated by PostGIS itself it
// returned lng -2.5e+169 for a point without an SRID, -1.5e+305 for a big-endian point, and — the
// dangerous one — a confident-looking coordinate for a LINESTRING instead of refusing. Pin
// geometries are LineStrings, so a future caller pointing this at one would have put a police
// warning on a street nobody reported.
function parsePointEwkb(hex) {
  if (typeof hex !== 'string') return null;
  const BACKSLASH_X = String.fromCharCode(92) + 'x';   // Postgres sometimes prefixes hex with it
  const h = hex.startsWith(BACKSLASH_X) ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length < 42) return null;

  const byteAt = (i) => parseInt(h.substr(i * 2, 2), 16);
  const order = byteAt(0);
  if (order !== 0 && order !== 1) return null;
  const little = order === 1;

  const readUint32 = (off) => {
    const b = [0, 1, 2, 3].map((i) => byteAt(off + i));
    const v = new Uint8Array(b);
    return new DataView(v.buffer).getUint32(0, little);
  };
  const readDouble = (off) => {
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = byteAt(off + i);
    return new DataView(b.buffer).getFloat64(0, little);
  };

  const rawType = readUint32(1);
  // EWKB packs flags into the high bits of the type word: SRID 0x20000000, Z 0x80000000,
  // M 0x40000000. The low bits are the geometry type — 1 is Point.
  const hasSrid = (rawType & 0x20000000) !== 0;
  const hasZ = (rawType & 0x80000000) !== 0;
  const hasM = (rawType & 0x40000000) !== 0;
  const baseType = rawType & 0x0000ffff;
  if (baseType !== 1) return null;              // not a Point: refuse rather than guess

  const coordsAt = 5 + (hasSrid ? 4 : 0);
  const needed = coordsAt + 16 + (hasZ ? 8 : 0) + (hasM ? 8 : 0);
  if (h.length < needed * 2) return null;

  const lng = readDouble(coordsAt);             // PostGIS stores X (longitude) first
  const lat = readDouble(coordsAt + 8);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // A parse that lands outside the possible range is a misparse, not a location.
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

// ---------- NVDB lit-street geometry ----------
// Statens vegvesen returns "LINESTRING Z(lat lon height, ...)" when asked with srid=4326.
// Latitude first, which is the reverse of the usual GeoJSON/WKT convention and exactly the sort of
// thing a parser gets backwards without anyone noticing: swapped, an Oslo street at 59.9N 10.7E
// would be drawn at 10.7N 59.9E, in the Indian Ocean.
//
// Every coordinate is range-checked and bad points are dropped rather than passed to the map as
// NaN. A line needs two surviving points to mean anything, so anything less returns null and is
// simply not drawn — a missing lit street is a small loss, a misplaced one is a lie about where it
// is safe to walk.
function parseWktLineStringZ(wkt) {
  if (typeof wkt !== 'string') return null;
  const open = wkt.indexOf('(');
  const close = wkt.lastIndexOf(')');
  if (open === -1 || close === -1 || close <= open + 1) return null;

  const points = wkt.slice(open + 1, close).split(',').map((triplet) => {
    const parts = triplet.trim().split(/\s+/);
    if (parts.length < 2) return null;
    const lat = Number(parts[0]);
    const lng = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lat, lng];
  }).filter(Boolean);

  return points.length >= 2 ? points : null;
}

// ---------- Walking a route ----------
// Where along a route someone currently is. Returns the index of the route vertex they are nearest
// to, plus how far off the line they are, so the caller can tell "walking it" from "nowhere near
// it" — a phone that has wandered 300m off the route should not be marking streets on it.
//
// Searching forward from the last known index rather than the whole line: a route that doubles back
// past its own start (out and home the same way, which is the commonest walk there is) otherwise
// snaps to the wrong half, and every mark for the second leg lands on the first.
function routeProgress(coords, lat, lng, fromIndex = 0) {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const start = Math.max(0, Math.min(fromIndex, coords.length - 1));
  let bestIndex = start;
  let bestDist = Infinity;
  for (let i = start; i < coords.length; i++) {
    const d = haversine(lat, lng, coords[i][0], coords[i][1]);
    if (d < bestDist) { bestDist = d; bestIndex = i; }
  }
  return { index: bestIndex, offRouteM: bestDist };
}

// The stretch just walked: back along the route from `index` until `metres` have been covered.
//
// This is the whole reason walk mode marks a segment instead of a point. Nobody stops mid-street to
// rate it — you keep walking and reach for the phone once you are past, so by the time the tap
// lands you are tens of metres beyond what you meant. A point dropped at that moment is in the
// wrong place and says the wrong thing; the stretch behind you is both what you meant and what
// survives a GPS fix that is 20m out.
//
// Always returns at least two points when the route has two, so a mark made in the first few steps
// still describes a line rather than collapsing to nothing.
function trailingRouteSegment(coords, index, metres = 100) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const end = Math.max(1, Math.min(index, coords.length - 1));
  let covered = 0;
  let start = end;
  while (start > 0 && covered < metres) {
    covered += haversine(coords[start][0], coords[start][1], coords[start - 1][0], coords[start - 1][1]);
    start--;
  }
  if (start === end) start = Math.max(0, end - 1);
  return coords.slice(start, end + 1).map(([la, ln]) => [la, ln]);
}

// Midpoint by distance along a path, used to ask "is there already a pin for this stretch?" from
// the middle of it rather than from either end, where the answer depends on which way you walked.
function pathMidpoint(path) {
  if (!Array.isArray(path) || !path.length) return null;
  if (path.length === 1) return { lat: path[0][0], lng: path[0][1] };
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  let walked = 0;
  for (let i = 1; i < path.length; i++) {
    const leg = haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (walked + leg >= total / 2) {
      const t = leg === 0 ? 0 : (total / 2 - walked) / leg;
      return {
        lat: path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
        lng: path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
      };
    }
    walked += leg;
  }
  const last = path[path.length - 1];
  return { lat: last[0], lng: last[1] };
}

// ---------- Opening hours ----------
// OpenStreetMap's `opening_hours` is a small language, not a time range: "Mo-Fr 08:00-20:00; Sa
// 10:00-16:00; Su off" is ordinary, and so are things this deliberately refuses to interpret.
//
// It returns true, false, or **null for "cannot tell"**, and the null is the important one. This
// decides whether a frightened person is sent to a door. A place wrongly shown as open costs them
// the two minutes it takes to walk there and find it locked, at the moment they least have two
// minutes — so anything not understood with certainty says so instead of guessing.
//
// Handled: 24/7; day ranges and lists (Mo-Fr, Sa,Su); several time spans in one rule; spans that
// cross midnight (22:00-04:00); explicit off/closed; later rules overriding earlier ones, which is
// how the format works. Everything else — public holidays, week numbers, months, sunset, "open" —
// makes the whole answer null rather than a confident half-reading.
const OH_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function ohDayIndexes(daySpec) {
  const out = new Set();
  for (const part of daySpec.split(',')) {
    const range = part.trim().match(/^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/);
    if (!range) return null;
    const from = OH_DAYS.indexOf(range[1]);
    const to = range[2] ? OH_DAYS.indexOf(range[2]) : from;
    // Wraps across Sunday: Fr-Mo means Fr, Sa, Su, Mo.
    for (let i = from; ; i = (i + 1) % 7) {
      out.add(i);
      if (i === to) break;
    }
  }
  return out;
}

function isOpenNow(spec, now = new Date()) {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const text = spec.trim();
  if (/^24\/7$/.test(text)) return true;

  const today = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();
  let verdict = null;      // what the last matching rule said
  let sawAnyRule = false;

  for (const raw of text.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    sawAnyRule = true;

    const parsed = rule.match(
      /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)?\s*(off|closed|(?:\d{1,2}:\d{2}-\d{1,2}:\d{2})(?:\s*,\s*\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/i,
    );
    // One thing we cannot read makes the whole answer unknown. A rule we skipped could be the
    // very one that closes this place tonight.
    if (!parsed) return null;

    const days = parsed[1] ? ohDayIndexes(parsed[1]) : null;
    if (parsed[1] && !days) return null;
    if (days && !days.has(today)) continue;

    const body = parsed[2].toLowerCase();
    if (body === 'off' || body === 'closed') { verdict = false; continue; }

    let openNow = false;
    for (const span of body.split(',')) {
      const t = span.trim().match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
      if (!t) return null;
      const start = Number(t[1]) * 60 + Number(t[2]);
      const end = Number(t[3]) * 60 + Number(t[4]);
      // 22:00-04:00 runs past midnight, so "now" counts if it is after the start OR before the end.
      if (end <= start ? (minutes >= start || minutes < end) : (minutes >= start && minutes < end)) {
        openNow = true;
      }
    }
    verdict = openNow;
  }

  if (!sawAnyRule) return null;
  // Every rule parsed and none of them mentioned today, which in this format means closed.
  return verdict === null ? false : verdict;
}
// Usable both as a plain <script> in the browser (attaches to globalThis, which is how app.js
// picks it up) and as a CommonJS module under Node, which is what lets the tests run headless.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversine, minDistanceToPaths, nearestPointOnPaths, nodeKey, buildStreetGraph, mergeWaysIntoGraph, routeSafetyScore, routeRankingClaim,
    nearestGraphNode, reachableFrom, shortestStreetPath, ratingBand, ratingDash, decodePolyline,
    hexToRgb, relativeLuminance, contrastRatio, pickReadableInk, adjustForContrast,
    rgbToHsl, hslToHex, INK_DARK, INK_LIGHT,
    bearingDegrees, compassPoint, describeDistance, describeAge, COMPASS_POINTS, parsePointEwkb, parseWktLineStringZ,
    routeProgress, trailingRouteSegment, pathMidpoint, isOpenNow,
  };
}
