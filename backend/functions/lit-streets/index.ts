// SafeWalk — lit streets (Statens vegvesen NVDB, object type 86)
//
// This exists because the layer cannot work from the browser at all, which took an embarrassingly
// long time to establish. NVDB answers any request whose User-Agent it does not like with
// 400 code 4017, "User-Agent er ingen gyldig nettleser" — and the detailed message asks for
// "en User-Agent header som identifiserer systemet du bruker for aa hente dataene", meaning it
// wants an application identifier, not a browser.
//
// A browser cannot comply. User-Agent is a forbidden header name: fetch() silently refuses to set
// it, and the browser sends its own. Verified from a real Chrome on the live HTTPS site, not
// assumed — 400, code 4017, with Chrome/152 as the User-Agent. So every SafeWalk user has been
// looking at a lit-streets layer that could never have drawn anything, on every device, since it
// shipped. The map key claimed the layer existed the whole time.
//
// Server-side we can send whatever identifies us honestly, which is all NVDB is asking for.

const NVDB = 'https://nvdbapiles-v3.atlas.vegvesen.no/vegobjekter/86';
// NVDB's own message asks for "a User-Agent that identifies the system", but its check actually
// gates on the string looking like a browser — measured: "SafeWalk/1.0 (...)" gets 400, the same
// request with a Mozilla/5.0 prefix gets 200. This is the conventional "compatible" form, which
// satisfies the check while still saying plainly who we are and where to complain. Not a Chrome
// string: there is no reason to pretend to be something we are not when this works.
const UA = 'Mozilla/5.0 (compatible; SafeWalk/1.0; +https://github.com/michaelsivertsennorge/SafeWalk)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

// Norway, generously. A bbox outside this is either a bug or someone using us as a general proxy.
const NORWAY = { west: 4, south: 57, east: 32, north: 72 };
// About 6km across at Norwegian latitudes. Bigger than the client ever asks for, and small enough
// that nobody can walk the whole country through this endpoint one request at a time.
const MAX_SPAN_DEG = 0.12;

function badRequest(why: string) {
  return new Response(JSON.stringify({ error: why }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const bbox = new URL(req.url).searchParams.get('bbox') || '';
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    return badRequest('bbox must be west,south,east,north');
  }
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return badRequest('bbox is inside out');
  if (east - west > MAX_SPAN_DEG || north - south > MAX_SPAN_DEG) {
    return badRequest('bbox too large — zoom in');
  }
  if (west < NORWAY.west || east > NORWAY.east || south < NORWAY.south || north > NORWAY.north) {
    return badRequest('bbox outside Norway, which is all NVDB covers');
  }

  try {
    const url = `${NVDB}?kartutsnitt=${west},${south},${east},${north}&srid=4326&inkluder=geometri&antall=1000`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      return new Response(JSON.stringify({ error: `NVDB ${res.status}`, detail: body }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
    const data = await res.json();

    // Only the geometry travels. The full NVDB object carries metadata the map has no use for, and
    // this response is on the critical path of panning the map.
    const lines = (data.objekter || [])
      .map((o: any) => o?.geometri?.wkt)
      .filter((w: unknown): w is string => typeof w === 'string' && w.startsWith('LINESTRING'));

    return new Response(JSON.stringify({ count: lines.length, lines }), {
      headers: {
        'Content-Type': 'application/json',
        // Street lighting does not move. A day of caching spares both NVDB and the phone's battery.
        'Cache-Control': 'public, max-age=86400',
        ...CORS,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err).slice(0, 200) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
});
