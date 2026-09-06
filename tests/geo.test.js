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
console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.error(`  FAIL  ${f}\n`));
  process.exit(1);
}
