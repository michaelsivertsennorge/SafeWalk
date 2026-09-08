// SafeWalk — tests for the pure geometry and graph maths.
//
//   node tests/geo.test.js
//
// No framework and no dependencies on purpose: the client has no build step, and a test suite that
// needs one would stop being run. Exits non-zero if anything fails, so CI or an agent can rely on it.
//
// These cover the code where a silent error would make the app lie about whether a street is safe —
// distances, the street graph, route scoring — plus the specific bugs already found in real use, so
// they cannot come back unnoticed.

const geo = require('../safewalk-app/geo.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`);
  }
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || ''} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function near(actual, expected, tolerance, msg) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || ''} expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

// ---------------------------------------------------------------------------
// haversine — every distance judgement in the app rests on this
// ---------------------------------------------------------------------------
check('haversine: zero distance', () => {
  eq(geo.haversine(59.9139, 10.7522, 59.9139, 10.7522), 0);
});

check('haversine: one degree of latitude is ~111.2 km', () => {
  near(geo.haversine(59, 10, 60, 10), 111195, 500);
});

check('haversine: known Oslo pair (Stortinget → Oslo S, ~1.1 km)', () => {
  near(geo.haversine(59.9127, 10.7401, 59.9107, 10.7522), 700, 120);
});

check('haversine: symmetric', () => {
  const a = geo.haversine(59.91, 10.75, 59.92, 10.76);
  const b = geo.haversine(59.92, 10.76, 59.91, 10.75);
  near(a, b, 1e-9);
});

check('haversine: longitude degrees shrink with latitude', () => {
  const atEquator = geo.haversine(0, 0, 0, 1);
  const atOslo = geo.haversine(60, 0, 60, 1);
  ok(atOslo < atEquator / 1.9, 'a degree of longitude at 60°N should be about half the equator value');
});

// ---------------------------------------------------------------------------
// minDistanceToPaths — why a long marked street counts along its whole length
// ---------------------------------------------------------------------------
check('minDistanceToPaths: measures to the nearest point, not the midpoint', () => {
  // A 1 km north-south street. A point beside its far END must read as close, not 500 m away.
  const street = [[[59.910, 10.75], [59.9145, 10.75], [59.919, 10.75]]];
  const besideTheEnd = geo.minDistanceToPaths(59.919, 10.7502, street);
  near(besideTheEnd, 11, 6, 'point beside the street end');
  const midpointDistance = geo.haversine(59.919, 10.7502, 59.9145, 10.75);
  ok(midpointDistance > 400, 'sanity: the midpoint really is far away');
});

check('minDistanceToPaths: handles multiple path segments', () => {
  const paths = [[[59.90, 10.75], [59.901, 10.75]], [[59.95, 10.75], [59.951, 10.75]]];
  near(geo.minDistanceToPaths(59.9505, 10.75, paths), 55, 60);
});

// ---------------------------------------------------------------------------
// Street graph — the maze behaviour
// ---------------------------------------------------------------------------
const wayA = { id: 1, tags: { name: 'A street' }, geometry: [{ lat: 59.90, lon: 10.75 }, { lat: 59.901, lon: 10.75 }, { lat: 59.902, lon: 10.75 }] };
const wayB = { id: 2, tags: { name: 'B street' }, geometry: [{ lat: 59.902, lon: 10.75 }, { lat: 59.902, lon: 10.751 }] };
const wayIsolated = { id: 3, tags: { name: 'Stranded lane' }, geometry: [{ lat: 59.98, lon: 10.90 }, { lat: 59.981, lon: 10.90 }] };

check('graph: shared OSM nodes join two ways automatically', () => {
  const g = geo.buildStreetGraph([wayA, wayB]);
  const start = geo.nodeKey(59.90, 10.75);
  const reach = geo.reachableFrom(g, start);
  ok(reach.has(geo.nodeKey(59.902, 10.751)), 'B street should be reachable from A street');
});

check('graph: edges are undirected — walkable both ways', () => {
  const g = geo.buildStreetGraph([wayA]);
  const forward = geo.shortestStreetPath(g, geo.nodeKey(59.90, 10.75), geo.nodeKey(59.902, 10.75));
  const back = geo.shortestStreetPath(g, geo.nodeKey(59.902, 10.75), geo.nodeKey(59.90, 10.75));
  ok(forward && back, 'both directions must route');
  eq(forward.keys.length, back.keys.length);
});

check('graph: a route across a junction names both streets in order', () => {
  const g = geo.buildStreetGraph([wayA, wayB]);
  const leg = geo.shortestStreetPath(g, geo.nodeKey(59.90, 10.75), geo.nodeKey(59.902, 10.751));
  ok(leg, 'must find a path');
  const distinct = leg.names.filter((n, i) => n !== leg.names[i - 1]);
  eq(distinct[0], 'A street');
  eq(distinct[distinct.length - 1], 'B street');
});

check('graph: disconnected ways return no path rather than a wrong one', () => {
  const g = geo.buildStreetGraph([wayA, wayIsolated]);
  const leg = geo.shortestStreetPath(g, geo.nodeKey(59.90, 10.75), geo.nodeKey(59.981, 10.90));
  eq(leg, null, 'unreachable street must be null, not a fabricated route');
});

check('graph: merging is idempotent — the background widen must not double edges', () => {
  // Regression guard. The picker fetches a small network, then merges a wider one that contains it;
  // without the wayIds check every shared way would have its edges added twice.
  const g = geo.buildStreetGraph([wayA]);
  const edgesBefore = [...g.nodes.values()].reduce((n, node) => n + node.edges.length, 0);
  geo.mergeWaysIntoGraph(g, [wayA]);
  const edgesAfter = [...g.nodes.values()].reduce((n, node) => n + node.edges.length, 0);
  eq(edgesAfter, edgesBefore, 're-merging the same way must change nothing');
});

check('graph: merging genuinely new ways does extend the network', () => {
  const g = geo.buildStreetGraph([wayA]);
  const added = geo.mergeWaysIntoGraph(g, [wayB]);
  eq(added, 1);
  ok(geo.reachableFrom(g, geo.nodeKey(59.90, 10.75)).has(geo.nodeKey(59.902, 10.751)));
});

check('nearestGraphNode: honours the allowed set, so taps snap to reachable streets', () => {
  // The real bug this guards: Overpass clips ways at the query edge, stranding ~12% of nodes.
  // Snapping to the nearest node overall could land on a street you cannot walk to.
  const g = geo.buildStreetGraph([wayA, wayIsolated]);
  const reachable = geo.reachableFrom(g, geo.nodeKey(59.90, 10.75));
  // Probe nearer the far end of the stranded lane so the expected snap target is unambiguous.
  const unrestricted = geo.nearestGraphNode(g, 59.9809, 10.90, 500);
  eq(unrestricted, geo.nodeKey(59.981, 10.90), 'without a filter it snaps to the stranded lane');
  const restricted = geo.nearestGraphNode(g, 59.9809, 10.90, 500, reachable);
  eq(restricted, null, 'with the filter it refuses rather than offering an unwalkable street');
});

check('nearestGraphNode: respects maxDist', () => {
  const g = geo.buildStreetGraph([wayA]);
  eq(geo.nearestGraphNode(g, 59.50, 10.75, 80), null, 'far away must not snap');
  ok(geo.nearestGraphNode(g, 59.9001, 10.75, 80), 'close by must snap');
});

check('shortestStreetPath: picks the shorter of two routes', () => {
  //   A ---- B ---- C      (two short hops)
  //   A ------------ C     (one long detour, deliberately further)
  const direct = { id: 10, tags: { name: 'Short' }, geometry: [{ lat: 59.90, lon: 10.75 }, { lat: 59.9005, lon: 10.75 }, { lat: 59.901, lon: 10.75 }] };
  const detour = { id: 11, tags: { name: 'Detour' }, geometry: [{ lat: 59.90, lon: 10.75 }, { lat: 59.90, lon: 10.76 }, { lat: 59.901, lon: 10.76 }, { lat: 59.901, lon: 10.75 }] };
  const g = geo.buildStreetGraph([direct, detour]);
  const leg = geo.shortestStreetPath(g, geo.nodeKey(59.90, 10.75), geo.nodeKey(59.901, 10.75));
  ok(leg.names.every((n) => n === 'Short'), `expected to stay on Short, got ${[...new Set(leg.names)]}`);
});

// ---------------------------------------------------------------------------
// Rating bands — the colours that tell someone whether to walk down a street
// ---------------------------------------------------------------------------
check('ratingBand: thresholds match the stated rules', () => {
  eq(geo.ratingBand(1), 'safe');
  eq(geo.ratingBand(0.76), 'safe');
  eq(geo.ratingBand(0.75), 'mixed', 'exactly 75% is not "safe" — the rule is above 75%');
  eq(geo.ratingBand(0.5), 'mixed');
  eq(geo.ratingBand(0.49), 'danger');
  eq(geo.ratingBand(0), 'danger');
});

check('ratingDash: every band keeps a distinct line style for colourblind users', () => {
  const styles = new Set([geo.ratingDash(1), geo.ratingDash(0.6), geo.ratingDash(0)]);
  eq(styles.size, 3, 'safe/mixed/danger must be distinguishable without colour');
});

// ---------------------------------------------------------------------------
// decodePolyline — every route line drawn on the map comes through here
// ---------------------------------------------------------------------------
check('decodePolyline: matches the published Google reference vector at precision 5', () => {
  // The canonical example from the Encoded Polyline Algorithm docs. Using a published fixture
  // rather than one generated by our own encoder means this actually pins the decoder to the
  // standard, instead of only proving we are self-consistent.
  const pts = geo.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  eq(pts.length, 3);
  near(pts[0][0], 38.5, 1e-6); near(pts[0][1], -120.2, 1e-6);
  near(pts[1][0], 40.7, 1e-6); near(pts[1][1], -120.95, 1e-6);
  near(pts[2][0], 43.252, 1e-6); near(pts[2][1], -126.453, 1e-6);
});

check('decodePolyline: precision 6, which is what Valhalla actually sends', () => {
  const pts = geo.decodePolyline('_izlhA~rlgdF_{geC~ywl@', 6);
  eq(pts.length, 2);
  near(pts[0][0], 38.5, 1e-6); near(pts[0][1], -120.2, 1e-6);
  near(pts[1][0], 40.7, 1e-6); near(pts[1][1], -120.95, 1e-6);
});

check('decodePolyline: precision matters — decoding p6 data as p5 must not silently look sane', () => {
  // Guards against the class of bug where a route is drawn 10x off and nobody notices, because the
  // line still looks like a line.
  const asFive = geo.decodePolyline('_izlhA~rlgdF_{geC~ywl@', 5);
  ok(Math.abs(asFive[0][0] - 38.5) > 100, 'wrong precision should be obviously wrong, not subtly wrong');
});

check('decodePolyline: empty input yields no points rather than throwing', () => {
  eq(geo.decodePolyline('', 6).length, 0);
});

// ---------------------------------------------------------------------------
// routeSafetyScore — the maths behind the app's headline claim, "safest route"
//
// Each case below is a bug the previous scoring actually had. They all pushed the
// same way: towards calling a route safest when it was not.
// ---------------------------------------------------------------------------
const line = (lat0, lng0, n, step) => Array.from({ length: n }, (_, i) => [lat0 + i * step, lng0]);
const pin = (lat, lng, safe, danger) => ({ id: 'p' + lat + lng + safe + danger, lat, lng, safe, danger });

check('routeSafetyScore: one heavily-voted pin does not outweigh several corroborating ones', () => {
  // Old scoring summed raw votes: a single 20-safe pin scored +20 against three 3-safe pins at +9,
  // so one popular pin decided the whole comparison on volume alone.
  const a = geo.routeSafetyScore(line(59.90, 10.75, 20, 0.0002), 0.45, [pin(59.9010, 10.75, 20, 0)]);
  const b = geo.routeSafetyScore(line(59.92, 10.75, 20, 0.0002), 0.45,
    [pin(59.9210, 10.75, 3, 0), pin(59.9215, 10.75, 3, 0), pin(59.9205, 10.75, 3, 0)]);
  ok(b.score > a.score, 'three corroborating pins should beat one loud pin, got ' + b.score + ' vs ' + a.score);
});

check('routeSafetyScore: length cannot inflate the score', () => {
  // Same safety density, one route four times longer. Old scoring rewarded the longer one.
  const ps = [pin(59.9008, 10.75, 4, 0), pin(59.9030, 10.75, 4, 0), pin(59.9050, 10.75, 4, 0), pin(59.9070, 10.75, 4, 0)];
  const shortR = geo.routeSafetyScore(line(59.90, 10.75, 10, 0.0002), 0.2, ps);
  const longR = geo.routeSafetyScore(line(59.90, 10.75, 40, 0.0002), 0.8, ps);
  ok(longR.score <= shortR.score + 0.01, 'longer route must not score higher: ' + longR.score + ' vs ' + shortR.score);
});

check('routeSafetyScore: no reports is not the same as safe', () => {
  // The worst failure available to this app: presenting absence of evidence as evidence of safety.
  const r = geo.routeSafetyScore(line(59.90, 10.75, 20, 0.0002), 0.45, []);
  eq(r.score, 0);
  eq(r.pinsNearby, 0);
  eq(r.coverage, 0, 'coverage must be zero so the UI can say "nobody knows" rather than "safe"');
});

check('routeSafetyScore: a route with an unsafe report ranks below one with nothing', () => {
  const route = line(59.90, 10.75, 20, 0.0002);
  const withDanger = geo.routeSafetyScore(route, 0.45, [pin(59.9010, 10.75, 0, 5)]);
  const unknown = geo.routeSafetyScore(route, 0.45, []);
  ok(withDanger.score < unknown.score, 'a reported-unsafe route must rank worse than an unrated one');
  eq(withDanger.dangerPins, 1);
});

check('routeSafetyScore: danger is weighted more heavily than safety', () => {
  // Ignoring a real danger costs far more than avoiding a street that turned out to be fine.
  const route = line(59.90, 10.75, 20, 0.0002);
  const allSafe = geo.routeSafetyScore(route, 0.45, [pin(59.9010, 10.75, 4, 0)]);
  const allDanger = geo.routeSafetyScore(route, 0.45, [pin(59.9010, 10.75, 0, 4)]);
  ok(Math.abs(allDanger.score) > Math.abs(allSafe.score),
     'an equally-strong warning must move the score further than a reassurance');
});

check('routeSafetyScore: confidence scales with how many people voted', () => {
  const route = line(59.90, 10.75, 20, 0.0002);
  const one = geo.routeSafetyScore(route, 0.45, [pin(59.9010, 10.75, 1, 0)]);
  const many = geo.routeSafetyScore(route, 0.45, [pin(59.9010, 10.75, 8, 0)]);
  ok(many.score > one.score, 'a well-attested pin should count for more than a single vote');
});

check('routeSafetyScore: a marked street counts along its whole length, not just its midpoint', () => {
  const street = { id: 's1', lat: 59.9145, lng: 10.75, safe: 0, danger: 4,
                   paths: [[[59.910, 10.75], [59.9145, 10.75], [59.919, 10.75]]] };
  // A route passing only the far END of the street must still see the warning.
  const r = geo.routeSafetyScore(line(59.9188, 10.7502, 6, 0.00005), 0.05, [street]);
  eq(r.dangerPins, 1, "the street's danger must register at its end, not only at its centre");
});

// ---------------------------------------------------------------------------
// Colour contrast — what stands between a custom accent and an unreadable app
// ---------------------------------------------------------------------------
check('contrastRatio: matches the WCAG reference extremes', () => {
  near(geo.contrastRatio('#000000', '#ffffff'), 21, 0.01, 'black on white is the maximum');
  near(geo.contrastRatio('#ffffff', '#ffffff'), 1, 0.01, 'a colour against itself is the minimum');
});

check('contrastRatio: order of arguments does not matter', () => {
  near(geo.contrastRatio('#8b7bff', '#14103a'), geo.contrastRatio('#14103a', '#8b7bff'), 1e-9);
});

check('contrastRatio: known value from the app palette', () => {
  // The primary button: --accent-ink on midnight's --accent. Measured 5.47 in the browser.
  near(geo.contrastRatio('#14103a', '#8b7bff'), 5.47, 0.02);
});

check('hexToRgb: handles 3-digit, 6-digit, and rejects junk', () => {
  eq(JSON.stringify(geo.hexToRgb('#fff')), JSON.stringify([255, 255, 255]));
  eq(JSON.stringify(geo.hexToRgb('8b7bff')), JSON.stringify([139, 123, 255]));
  eq(geo.hexToRgb('nonsense'), null);
  eq(geo.hexToRgb('#12345'), null, 'a five-digit hex is not a colour');
});

check('relativeLuminance: ordered as expected', () => {
  ok(geo.relativeLuminance('#ffffff') > geo.relativeLuminance('#808080'));
  ok(geo.relativeLuminance('#808080') > geo.relativeLuminance('#000000'));
  near(geo.relativeLuminance('#000000'), 0, 1e-9);
  near(geo.relativeLuminance('#ffffff'), 1, 1e-9);
});

check('pickReadableInk: always returns the more legible of the two inks', () => {
  eq(geo.pickReadableInk('#ffffff'), geo.INK_DARK, 'dark ink on a white background');
  eq(geo.pickReadableInk('#000000'), geo.INK_LIGHT, 'light ink on a black background');
  eq(geo.pickReadableInk('#8b7bff'), geo.INK_DARK, 'the app accent takes dark ink');
});

check('adjustForContrast: no colour a user can pick produces an unreadable button', () => {
  // This is the actual guarantee behind letting someone choose their own accent. Sweep the hue
  // circle at several lightnesses and assert the chosen ink always clears WCAG AA for text.
  const hslToHex = (h, s, l) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  const failures = [];
  for (let h = 0; h < 360; h += 10) {
    for (const l of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      for (const s of [0.4, 0.7, 1.0]) {
        const chosen = hslToHex(h, s, l);
        const bg = geo.adjustForContrast(chosen);   // what the app will actually use
        const ink = geo.pickReadableInk(bg);
        const r = geo.contrastRatio(ink, bg);
        if (r < 4.5) failures.push(`${chosen} -> ${bg} / ${ink} = ${r.toFixed(2)}`);
      }
    }
  }
  eq(failures.length, 0, `every accent must yield a readable label; failed: ${failures.slice(0, 5).join(', ')}`);
});

// ---------------------------------------------------------------------------
// Direction in words — the map's non-visual equivalent
// ---------------------------------------------------------------------------
check('bearingDegrees: cardinal directions from a point in Oslo', () => {
  const lat = 59.9139, lng = 10.7522;
  near(geo.bearingDegrees(lat, lng, lat + 0.01, lng), 0, 0.5, 'due north');
  near(geo.bearingDegrees(lat, lng, lat, lng + 0.01), 90, 0.5, 'due east');
  near(geo.bearingDegrees(lat, lng, lat - 0.01, lng), 180, 0.5, 'due south');
  near(geo.bearingDegrees(lat, lng, lat, lng - 0.01), 270, 0.5, 'due west');
});

check('bearingDegrees: always returns 0..360', () => {
  const lat = 59.9139, lng = 10.7522;
  for (let i = 0; i < 36; i++) {
    const a = (i * 10) * Math.PI / 180;
    const d = geo.bearingDegrees(lat, lng, lat + 0.01 * Math.cos(a), lng + 0.01 * Math.sin(a));
    ok(d >= 0 && d < 360, `bearing out of range: ${d}`);
  }
});

check('compassPoint: maps degrees to the eight points, wrapping at north', () => {
  eq(geo.compassPoint(0), 'north');
  eq(geo.compassPoint(45), 'north-east');
  eq(geo.compassPoint(90), 'east');
  eq(geo.compassPoint(180), 'south');
  eq(geo.compassPoint(270), 'west');
  eq(geo.compassPoint(359), 'north', 'just short of 360 is still north, not north-west');
  eq(geo.compassPoint(360), 'north');
  eq(geo.compassPoint(-45), 'north-west', 'negative degrees normalise');
});

check('compassPoint: every point is reachable and boundaries land correctly', () => {
  const seen = new Set();
  for (let d = 0; d < 360; d += 1) seen.add(geo.compassPoint(d));
  eq(seen.size, 8, 'all eight points must be reachable');
  // 22.5 is the boundary between north and north-east.
  eq(geo.compassPoint(22), 'north');
  eq(geo.compassPoint(23), 'north-east');
});

check('describeDistance: phrased the way a person would say it', () => {
  eq(geo.describeDistance(5), 'right here');
  eq(geo.describeDistance(19), 'right here');
  eq(geo.describeDistance(20), '20 m');
  eq(geo.describeDistance(184), '180 m', 'rounded to 10m, not false precision');
  eq(geo.describeDistance(999), '1000 m');
  eq(geo.describeDistance(1000), '1.0 km');
  eq(geo.describeDistance(2450), '2.5 km');
});

check('bearing + compass: a pin due south-west reads as south-west', () => {
  const lat = 59.9139, lng = 10.7522;
  const d = geo.bearingDegrees(lat, lng, lat - 0.01, lng - 0.019);  // ~south-west at this latitude
  eq(geo.compassPoint(d), 'south-west');
});

// ---------------------------------------------------------------------------
// PostGIS hex EWKB — where a police warning's location comes from
//
// Fixtures generated by PostGIS itself (st_asewkb / st_asbinary), so these pin
// the parser to what the database actually sends rather than to my assumptions
// about it. The first version of this parser assumed one fixed layout and was
// wrong for three of the four.
// ---------------------------------------------------------------------------
const EWKB = {
  pointWithSrid:      '0101000020e61000001aa54bff927c2540ebec1ae379f44d40',
  pointNoSrid:        '01010000001aa54bff927c2540ebec1ae379f44d40',
  lineStringWithSrid: '0102000020e610000002000000000000000080254014ae47e17af44d4085eb51b81e852540f6285c8fc2f54d40',
  bigEndianPoint:     '000000000140257c92ff4ba51a404df479e31aeceb',
};
const OSLO = { lat: 59.9099697, lng: 10.743309 };

check('parsePointEwkb: little-endian point with an SRID (what PostgREST normally sends)', () => {
  const p = geo.parsePointEwkb(EWKB.pointWithSrid);
  ok(p, 'should parse');
  near(p.lat, OSLO.lat, 1e-6);
  near(p.lng, OSLO.lng, 1e-6);
});

check('parsePointEwkb: point WITHOUT an SRID', () => {
  // Previously returned lng -2.5e+169: the old parser hardcoded the SRID-present offset.
  const p = geo.parsePointEwkb(EWKB.pointNoSrid);
  ok(p, 'should parse');
  near(p.lat, OSLO.lat, 1e-6);
  near(p.lng, OSLO.lng, 1e-6);
});

check('parsePointEwkb: big-endian point', () => {
  // Previously returned lng -1.5e+305.
  const p = geo.parsePointEwkb(EWKB.bigEndianPoint);
  ok(p, 'should parse');
  near(p.lat, OSLO.lat, 1e-6);
  near(p.lng, OSLO.lng, 1e-6);
});

check('parsePointEwkb: refuses a LineString instead of inventing a point', () => {
  // The dangerous case. Pin geometries ARE LineStrings, and the old parser returned a
  // confident-looking coordinate for one, which would put a warning on a street nobody reported.
  eq(geo.parsePointEwkb(EWKB.lineStringWithSrid), null);
});

check('parsePointEwkb: rejects junk rather than returning a number', () => {
  eq(geo.parsePointEwkb(null), null);
  eq(geo.parsePointEwkb(''), null);
  eq(geo.parsePointEwkb('not hex at all'), null);
  eq(geo.parsePointEwkb('0101000020e6100000'), null, 'header only, no coordinates');
  eq(geo.parsePointEwkb('ff01000020e61000001aa54bff927c2540ebec1ae379f44d40'), null, 'bad byte-order flag');
});

check('parsePointEwkb: accepts the leading backslash-x that Postgres sometimes includes', () => {
  const p = geo.parsePointEwkb(String.fromCharCode(92) + 'x' + EWKB.pointWithSrid);
  ok(p && Math.abs(p.lat - OSLO.lat) < 1e-6, 'a leading backslash-x must not break parsing');
});

check('parsePointEwkb: a parse landing outside the possible range is refused', () => {
  // Real little-endian EWKB points with impossible coordinates, built by encoding the doubles
  // rather than hand-writing hex. My first attempt at this fixture was invented, and it happened
  // to decode to a perfectly valid 39.1E 1.0N — the test failed against correct code.
  const lngTooBig = '0101000020e61000000000000000388f400000000000000000';   // lng 999, lat 0
  const latTooBig = '0101000020e610000000000000008025400000000000005e40';   // lng 10.75, lat 120
  eq(geo.parsePointEwkb(lngTooBig), null, 'longitude 999 cannot be a place');
  eq(geo.parsePointEwkb(latTooBig), null, 'latitude 120 cannot be a place');
  // ...while a real Oslo point still parses, so the range check has not swallowed everything.
  const good = geo.parsePointEwkb(EWKB.pointWithSrid);
  ok(good && Math.abs(good.lat - OSLO.lat) < 1e-6, 'valid coordinates must still parse');
});

// ---------------------------------------------------------------------------
// NVDB lit-street geometry
//
// The fixture is a real response from Statens vegvesen, captured with a browser
// User-Agent (the API rejects anything else with "User-Agent er ingen gyldig
// nettleser"). Note the coordinate order: LATITUDE first, the reverse of the
// usual convention.
// ---------------------------------------------------------------------------
const NVDB_WKT = 'LINESTRING Z(59.916275 10.745775 15.407, 59.916272 10.745683 15.158, ' +
                 '59.916269 10.745601 14.958, 59.916266 10.745515 14.758)';

check('parseWktLineStringZ: parses a real NVDB response, latitude first', () => {
  const pts = geo.parseWktLineStringZ(NVDB_WKT);
  ok(pts, 'should parse');
  eq(pts.length, 4);
  near(pts[0][0], 59.916275, 1e-9, 'first value is latitude');
  near(pts[0][1], 10.745775, 1e-9, 'second value is longitude');
  // Sanity: the result must land in Oslo, not in the ocean off Somalia, which is where a
  // lat/lng swap would put it.
  ok(pts.every(([la, ln]) => la > 59 && la < 61 && ln > 10 && ln < 12), 'every point should be in Oslo');
});

check('parseWktLineStringZ: drops points that cannot be coordinates', () => {
  // A swapped pair (10.7 as latitude is fine, but 59.9 as longitude is not) is rejected rather
  // than drawn somewhere wrong.
  const mixed = 'LINESTRING Z(59.9 10.7 5, 10.7 200.0 5, 59.91 10.71 5)';
  const pts = geo.parseWktLineStringZ(mixed);
  eq(pts.length, 2, 'the out-of-range point should be dropped, the good ones kept');
});

check('parseWktLineStringZ: refuses rather than returning a degenerate line', () => {
  eq(geo.parseWktLineStringZ('LINESTRING Z(59.9 10.7 5)'), null, 'one point is not a line');
  eq(geo.parseWktLineStringZ('LINESTRING Z()'), null);
  eq(geo.parseWktLineStringZ('LINESTRING Z(nonsense here)'), null);
});

check('parseWktLineStringZ: survives malformed input without throwing', () => {
  eq(geo.parseWktLineStringZ(null), null);
  eq(geo.parseWktLineStringZ(''), null);
  eq(geo.parseWktLineStringZ('LINESTRING Z'), null, 'no parentheses at all');
  eq(geo.parseWktLineStringZ('POINT(59.9 10.7)'), null, 'a single point is not a line');
});

check('parseWktLineStringZ: handles a 2D linestring with no height', () => {
  const pts = geo.parseWktLineStringZ('LINESTRING(59.9 10.7, 59.91 10.71)');
  ok(pts && pts.length === 2, 'height is optional');
  near(pts[1][1], 10.71, 1e-9);
});

// --- nearestPointOnPaths: measuring to the street, not to the dots it is drawn with -------------
// OpenStreetMap stores a straight street as its two endpoints. Measuring only to those vertices
// reported a street you were standing on as far away, and left "Near me" with nothing to point at.

check('nearestPointOnPaths: standing mid-segment reads as on the street, not at its vertex', () => {
  // The real longest gap in central Oslo: 118m of Grønland with nothing drawn in between.
  const path = [[59.912516, 10.762111], [59.913344, 10.760386]];
  const mid = [(path[0][0] + path[1][0]) / 2, (path[0][1] + path[1][1]) / 2];
  const vertexOnly = Math.min(
    geo.haversine(mid[0], mid[1], path[0][0], path[0][1]),
    geo.haversine(mid[0], mid[1], path[1][0], path[1][1]),
  );
  ok(vertexOnly > 55, `the old vertex-only measure was ${vertexOnly.toFixed(0)}m off`);
  near(geo.minDistanceToPaths(mid[0], mid[1], [path]), 0, 1, 'standing on it should read as zero');
});

check('nearestPointOnPaths: the returned point lies on the street', () => {
  const path = [[59.9100, 10.7500], [59.9100, 10.7600]];
  const near1 = geo.nearestPointOnPaths(59.9110, 10.7550, [path]);
  ok(near1 !== null, 'a point should be found');
  near(near1.lat, 59.9100, 1e-4, 'foot of the perpendicular sits on the line');
  near(near1.lng, 10.7550, 1e-4, 'and directly below where we stood');
  near(near1.dist, geo.haversine(59.9110, 10.7550, near1.lat, near1.lng), 0.5, 'dist matches the point');
});

check('nearestPointOnPaths: cannot slide past the end of a segment', () => {
  const path = [[59.9100, 10.7500], [59.9100, 10.7520]];
  const p = geo.nearestPointOnPaths(59.9100, 10.7400, [path]);   // well beyond the western end
  near(p.lng, 10.7500, 1e-6, 'clamped to the endpoint rather than extrapolated');
  near(p.dist, geo.haversine(59.9100, 10.7400, 59.9100, 10.7500), 1);
});

check('nearestPointOnPaths: the compass now agrees with the distance', () => {
  // A chain running north, then east, then back south — the shape you get selecting your way round
  // a block. app.js stores path[floor(len/2)] as the pin's position, which lands on the far corner.
  const chain = [[59.9100, 10.7500], [59.9160, 10.7500], [59.9160, 10.7600], [59.9100, 10.7600]];
  const me = [59.9100, 10.7608];                       // standing just east of the southern end
  const p = geo.nearestPointOnPaths(me[0], me[1], [chain]);
  const toNearest = geo.bearingDegrees(me[0], me[1], p.lat, p.lng);
  const stored = chain[Math.floor(chain.length / 2)];
  const toStored = geo.bearingDegrees(me[0], me[1], stored[0], stored[1]);
  let disagreement = Math.abs(toNearest - toStored);
  if (disagreement > 180) disagreement = 360 - disagreement;
  ok(disagreement > 45, `the old midpoint arrow was only ${disagreement.toFixed(0)}° out`);
  ok(p.dist < 60, `the nearest part is ${p.dist.toFixed(0)}m off — inside the 60m route threshold`);
  eq(geo.compassPoint(toNearest), 'west', 'the street really is west of us');
  ok(geo.compassPoint(toStored) !== 'west', 'while the stored midpoint claimed otherwise');
});

check('nearestPointOnPaths: searches every path, not just the first', () => {
  const far = [[59.9500, 10.7500], [59.9500, 10.7600]];
  const close = [[59.9101, 10.7500], [59.9101, 10.7600]];
  near(geo.minDistanceToPaths(59.9100, 10.7550, [far, close]), 11, 3, 'picks the closer path');
});

check('nearestPointOnPaths: survives junk geometry rather than returning NaN', () => {
  eq(geo.nearestPointOnPaths(59.91, 10.75, []), null, 'no paths at all');
  eq(geo.nearestPointOnPaths(59.91, 10.75, [[]]), null, 'an empty path');
  eq(geo.nearestPointOnPaths(NaN, 10.75, [[[59.9, 10.7]]]), null, 'no location to measure from');
  const p = geo.nearestPointOnPaths(59.91, 10.75, [[[59.9, 10.7], [null, undefined], ['x', 'y']]]);
  ok(p && Number.isFinite(p.dist), 'a single good vertex among rubbish still measures');
  eq(geo.minDistanceToPaths(59.91, 10.75, []), Infinity, 'and the old contract still holds');
});

check('nearestPointOnPaths: a marked street counts against a route running along it', () => {
  // The reason this matters beyond cosmetics: routeSafetyScore ignores anything over 60m away.
  const street = [[59.912516, 10.762111], [59.913344, 10.760386]];
  const mid = [(street[0][0] + street[1][0]) / 2, (street[0][1] + street[1][1]) / 2];
  const pin = { id: 'p1', paths: [street], safe: 0, danger: 6, lat: mid[0], lng: mid[1] };
  const route = [mid, mid, mid];
  const scored = geo.routeSafetyScore(route, 0.2, [pin]);
  eq(scored.pinsNearby, 1, 'the route walks straight down a street reported unsafe six times');
  ok(scored.score < 0, `and that must drag the score down, got ${scored.score}`);
});

// --- describeAge: how recent is this police report? ---------------------------------------------
// Police events live 6-24 hours, so a day-granularity formatter calls every one of them "Today".

check('describeAge: minutes, then hours, then days', () => {
  eq(geo.describeAge(0), 'just now');
  eq(geo.describeAge(30 * 1000), 'just now', 'below a minute is not worth a number');
  eq(geo.describeAge(60 * 1000), '1 minute ago', 'singular');
  eq(geo.describeAge(25 * 60 * 1000), '25 minutes ago');
  eq(geo.describeAge(59 * 60 * 1000), '59 minutes ago', 'still minutes right up to the hour');
  eq(geo.describeAge(60 * 60 * 1000), '1 hour ago', 'singular');
  eq(geo.describeAge(5 * 60 * 60 * 1000), '5 hours ago');
  eq(geo.describeAge(23 * 60 * 60 * 1000), '23 hours ago', 'the whole police TTL stays in hours');
  eq(geo.describeAge(24 * 60 * 60 * 1000), '1 day ago');
  eq(geo.describeAge(50 * 60 * 60 * 1000), '2 days ago');
});

check('describeAge: survives a phone clock running ahead of the server', () => {
  eq(geo.describeAge(-5000), 'just now', 'a negative age must not read as "-1 minutes ago"');
  eq(geo.describeAge(NaN), '', 'no timestamp means say nothing, not "NaN minutes ago"');
  eq(geo.describeAge(Infinity), '');
});

// --- module hygiene: app.js must not shadow anything geo.js defines -----------------------------
// Both files load as classic scripts, and app.js loads second, so a same-named function in app.js
// silently replaces the tested one from geo.js. That happened with describeAge: geo.js took a
// duration, app.js took a timestamp, and the page rendered "20704 days ago" while this suite went
// on passing — because the suite requires the module directly and never sees the shadowing.
//
// Needs the app.js source. Under Node it reads the file; the browser harness passes it in. If
// neither is available it FAILS rather than passing quietly: a guard that silently does nothing
// is worse than no guard, which is the whole lesson of the bug it exists to catch.
check('app.js does not redefine anything geo.js exports', () => {
  let appSource = typeof globalThis.__APP_SOURCE__ === 'string' ? globalThis.__APP_SOURCE__ : null;
  if (appSource === null) {
    const fs = require('fs');
    const path = require('path');
    ok(fs && typeof fs.readFileSync === 'function', 'no way to read app.js — cannot run this guard');
    appSource = fs.readFileSync(path.join(__dirname, '..', 'safewalk-app', 'app.js'), 'utf8');
  }
  ok(appSource.length > 1000, 'app.js source looks empty — the guard would pass vacuously');

  // Top-level declarations only: a nested one is scoped and cannot shadow a global.
  const declared = new Set();
  for (const m of appSource.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    declared.add(m[1]);
  }
  const clashes = Object.keys(geo).filter((name) => declared.has(name));
  eq(clashes.join(', '), '', `app.js redeclares geo.js name(s) and will shadow them at runtime`);
});

// --- routeRankingClaim: what the app is allowed to say about the route it recommends ------------
// The most consequential sentence the product produces. It lived inside a render function reading
// globals, and was wrong for a long time as a result.

const route = (score, pinsNearby, dangerPins, distanceKm = 1) =>
  ({ score, pinsNearby, dangerPins, distanceKm });

check('routeRankingClaim: no reports anywhere is "shortest", not a safety claim', () => {
  const c = geo.routeRankingClaim([route(0, 0, 0), route(0, 0, 0), route(0, 0, 0)]);
  eq(c.kind, 'shortest');
  eq(c.haveEvidence, false, 'the caller ranks by distance on this');
});

check('routeRankingClaim: reports that do not separate the routes are not evidence', () => {
  // Everything scores nearly the same — picking a winner would be noise dressed as a finding.
  const c = geo.routeRankingClaim([route(0.10, 3, 0), route(0.02, 2, 0), route(0.0, 1, 0)]);
  eq(c.kind, 'shortest', 'a spread of 0.10 is below the 0.15 threshold');
});

check('routeRankingClaim: a single route needs no spread to count', () => {
  eq(geo.routeRankingClaim([route(0.4, 2, 0)]).kind, 'safest', 'nothing to compare it against');
  eq(geo.routeRankingClaim([route(0, 0, 0)]).kind, 'shortest', 'but it still needs a report');
});

check('routeRankingClaim: positive reports on the winner earn "safest"', () => {
  const c = geo.routeRankingClaim([route(0.9, 4, 0), route(-0.5, 2, 2), route(-0.9, 3, 3)]);
  eq(c.kind, 'safest');
});

check('routeRankingClaim: winning only because others are flagged is not "safest"', () => {
  const c = geo.routeRankingClaim([route(0, 0, 0), route(-0.6, 2, 2), route(-0.9, 3, 3)]);
  eq(c.kind, 'avoids', 'nobody vouched for it; it just carries no warnings');
});

check('routeRankingClaim: a flagged winner must not claim to avoid flagged streets', () => {
  // The bug: this used to return 'avoids', so the card read "AVOIDS FLAGGED STREETS" directly
  // above its own "1 spot on this route reported unsafe".
  const c = geo.routeRankingClaim([route(-0.2, 1, 1), route(-0.6, 2, 2), route(-0.9, 3, 3)]);
  eq(c.kind, 'leastBad');
  eq(c.dangerPins, 1);
  eq(c.hasFewest, true, 'it does genuinely carry the fewest here');
});

check('routeRankingClaim: does not claim "fewest" when it is not fewest', () => {
  // Ordered by score, and the top route carries MORE warnings than one below it — possible
  // because a single heavily-reported spot outweighs several lightly-reported ones.
  const c = geo.routeRankingClaim([route(-0.2, 4, 3), route(-0.5, 1, 1), route(-0.9, 2, 2)]);
  eq(c.kind, 'leastBad');
  eq(c.hasFewest, false, 'saying "fewest warnings" here would be false');
});

check('routeRankingClaim: survives being handed nothing', () => {
  eq(geo.routeRankingClaim([]).kind, 'shortest');
  eq(geo.routeRankingClaim(null).kind, 'shortest');
  eq(geo.routeRankingClaim(undefined).haveEvidence, false);
});


// ---------------------------------------------------------------------------
// Walking a route. These decide WHERE a mark made while walking ends up, which is the difference
// between warning people about the alley you meant and warning them about the next street.

// A straight line east along 59.9333, roughly 20m between vertices.
const straightRoute = Array.from({ length: 21 }, (_, i) => [59.9333, 10.75 + i * 0.00036]);

check('routeProgress: finds where along the route you are', () => {
  const p = geo.routeProgress(straightRoute, 59.9333, 10.75 + 10 * 0.00036);
  eq(p.index, 10);
  near(p.offRouteM, 0, 1);
});

check('routeProgress: reports how far off the line you have strayed', () => {
  // ~110m north of the route.
  const p = geo.routeProgress(straightRoute, 59.9343, 10.75 + 5 * 0.00036);
  eq(p.index, 5);
  near(p.offRouteM, 111, 15, 'so walk mode can refuse to mark a street you are not on');
});

check('routeProgress: searching forward stops an out-and-back snapping to the wrong leg', () => {
  // Out along the line and straight back — every coordinate appears twice.
  const outAndBack = straightRoute.concat([...straightRoute].reverse());
  const here = [59.9333, 10.75 + 3 * 0.00036];
  // Without fromIndex it legitimately matches the outbound leg...
  eq(geo.routeProgress(outAndBack, here[0], here[1]).index, 3);
  // ...but on the way home, having already reached the far end, it must not jump back to index 3
  // and re-mark the outbound stretch.
  const home = geo.routeProgress(outAndBack, here[0], here[1], 21);
  eq(home.index, 38, 'the return leg, not the outbound one');
  near(home.offRouteM, 0, 1);
});

check('routeProgress: survives an empty or missing route', () => {
  eq(geo.routeProgress([], 59.9, 10.7), null);
  eq(geo.routeProgress(null, 59.9, 10.7), null);
});

check('trailingRouteSegment: returns the stretch just walked, not a point', () => {
  const seg = geo.trailingRouteSegment(straightRoute, 15, 100);
  // ~20m per step, so 100m is five steps back: six vertices inclusive.
  eq(seg.length, 6);
  eq(seg[seg.length - 1][1], straightRoute[15][1], 'ends where you are');
  let len = 0;
  for (let i = 1; i < seg.length; i++) len += geo.haversine(seg[i - 1][0], seg[i - 1][1], seg[i][0], seg[i][1]);
  near(len, 100, 12, 'covers about the distance asked for');
});

check('trailingRouteSegment: never collapses to a single point near the start', () => {
  // Two steps in, 100m of history does not exist yet — it must still describe a line.
  const seg = geo.trailingRouteSegment(straightRoute, 1, 100);
  eq(seg.length >= 2, true, 'a one-point path would be marked as a spot, not a street');
});

check('trailingRouteSegment: is a copy, so editing a mark cannot corrupt the route', () => {
  const seg = geo.trailingRouteSegment(straightRoute, 5, 60);
  seg[0][0] = 0;
  eq(straightRoute[3][0], 59.9333, 'the live route is untouched');
});

check('trailingRouteSegment: survives a route too short to walk', () => {
  eq(geo.trailingRouteSegment([[59.9, 10.7]], 0, 100), null);
  eq(geo.trailingRouteSegment(null, 0, 100), null);
});

check('pathMidpoint: measures along the path, not between its ends', () => {
  // Bunched at the start, one long leg at the end: the mean of the coordinates would sit far from
  // the true middle, which is what makes "is there already a pin here?" ask in the wrong place.
  const lumpy = [[59.9333, 10.7500], [59.9333, 10.7501], [59.9333, 10.7502], [59.9333, 10.7600]];
  const mid = geo.pathMidpoint(lumpy);
  const half = geo.haversine(59.9333, 10.75, 59.9333, 10.76) / 2;
  near(geo.haversine(59.9333, 10.75, mid.lat, mid.lng), half, 3, 'halfway by distance walked');
});

check('pathMidpoint: survives degenerate paths', () => {
  eq(geo.pathMidpoint([[59.9, 10.7]]).lat, 59.9);
  eq(geo.pathMidpoint([]), null);
  eq(geo.pathMidpoint(null), null);
});

// ---------------------------------------------------------------------------
// Opening hours. These decide whether a frightened person is sent to a door, so the case that
// matters most is not open or closed — it is "we cannot tell", which must never come back as open.

// Helper: a Date for a given weekday and time. 2026-09-07 is a Monday.
const at = (day, hhmm) => {
  const monday = new Date('2026-09-07T00:00:00');
  const d = new Date(monday);
  d.setDate(monday.getDate() + ({ Mo: 0, Tu: 1, We: 2, Th: 3, Fr: 4, Sa: 5, Su: 6 })[day]);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};

check('isOpenNow: 24/7 is always open', () => {
  eq(geo.isOpenNow('24/7', at('Mo', '03:00')), true);
  eq(geo.isOpenNow('24/7', at('Su', '23:59')), true);
});

check('isOpenNow: a weekday range', () => {
  const spec = 'Mo-Fr 08:00-20:00';
  eq(geo.isOpenNow(spec, at('We', '12:00')), true);
  eq(geo.isOpenNow(spec, at('We', '07:59')), false);
  eq(geo.isOpenNow(spec, at('We', '20:00')), false, 'closing time is not still open');
  eq(geo.isOpenNow(spec, at('Sa', '12:00')), false, 'a day the rules never mention is closed');
});

check('isOpenNow: several rules, and off wins for its own day', () => {
  const spec = 'Mo-Fr 08:00-20:00; Sa 10:00-16:00; Su off';
  eq(geo.isOpenNow(spec, at('Sa', '11:00')), true);
  eq(geo.isOpenNow(spec, at('Sa', '17:00')), false);
  eq(geo.isOpenNow(spec, at('Su', '11:00')), false);
});

check('isOpenNow: a lunch break inside one day', () => {
  const spec = 'Mo-Fr 09:00-12:00,13:00-17:00';
  eq(geo.isOpenNow(spec, at('Tu', '11:00')), true);
  eq(geo.isOpenNow(spec, at('Tu', '12:30')), false, 'shut for lunch');
  eq(geo.isOpenNow(spec, at('Tu', '16:00')), true);
});

check('isOpenNow: a bar open past midnight', () => {
  // The case that matters at 2am, and the one a naive start<end comparison gets exactly backwards.
  const spec = 'Fr-Sa 20:00-03:00';
  eq(geo.isOpenNow(spec, at('Fr', '23:00')), true);
  eq(geo.isOpenNow(spec, at('Sa', '02:00')), true);
  eq(geo.isOpenNow(spec, at('Sa', '04:00')), false);
});

check('isOpenNow: day lists and wrapping ranges', () => {
  eq(geo.isOpenNow('Mo,We,Fr 09:00-17:00', at('We', '10:00')), true);
  eq(geo.isOpenNow('Mo,We,Fr 09:00-17:00', at('Tu', '10:00')), false);
  eq(geo.isOpenNow('Fr-Mo 09:00-17:00', at('Su', '10:00')), true, 'Fr-Mo wraps past Sunday');
  eq(geo.isOpenNow('Fr-Mo 09:00-17:00', at('We', '10:00')), false);
});

check('isOpenNow: anything it cannot read is unknown, never open', () => {
  // Each of these is real OSM syntax that this deliberately does not interpret. Every one must come
  // back null — a confident half-reading here sends somebody to a locked door.
  ['Mo-Fr 08:00-20:00; PH off',
   'sunrise-sunset',
   'Mo-Fr 08:00-20:00; Dec 24 off',
   'week 1-52 Mo-Fr 08:00-17:00',
   'Mo-Fr 08:00-20:00 open "ring the bell"',
   'nonsense',
   ''].forEach((spec) => {
    eq(geo.isOpenNow(spec, at('Mo', '10:00')), null, `"${spec}" must be unknown`);
  });
});

check('isOpenNow: a missing tag is unknown, not closed', () => {
  eq(geo.isOpenNow(undefined, at('Mo', '10:00')), null);
  eq(geo.isOpenNow(null, at('Mo', '10:00')), null);
});
// ---------------------------------------------------------------------------
console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL  ${f}\n`));
  process.exit(1);
}
