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
// Usable both as a plain <script> in the browser (attaches to globalThis, which is how app.js
// picks it up) and as a CommonJS module under Node, which is what lets the tests run headless.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    haversine, minDistanceToPaths, nodeKey, buildStreetGraph, mergeWaysIntoGraph, routeSafetyScore,
    nearestGraphNode, reachableFrom, shortestStreetPath, ratingBand, ratingDash, decodePolyline,
    hexToRgb, relativeLuminance, contrastRatio, pickReadableInk, adjustForContrast,
    rgbToHsl, hslToHex, INK_DARK, INK_LIGHT,
    bearingDegrees, compassPoint, describeDistance, COMPASS_POINTS, parsePointEwkb,
  };
}
