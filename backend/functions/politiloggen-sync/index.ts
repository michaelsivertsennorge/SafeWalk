// SafeWalk — Politiloggen sync
//
// Mirrors Norwegian police incident reports (politiet.no, NLOD 2.0) into police_events.
//
// Runs server-side for two reasons: Politiloggen blocks CORS, and writing to police_events needs
// the service role. Clients only ever read that table.
//
// Three judgements do most of the work here, all of them measured rather than assumed.
//
// 1. WHICH INCIDENTS COUNT. Politiloggen is mostly traffic and fires. Across 50 Oslo messages:
//    21 Trafikk, 13 Brann, 6 Savnet, 5 Andre hendelser, 3 Voldshendelse, 2 Ro og orden. A car
//    crash does not make a street unsafe to walk down, and painting the map red for one would
//    bury the incidents that do. Only categories bearing on personal safety on foot are mirrored.
//
// 2. WHERE IT HAPPENED. Only a municipality and a free-text area are given, never coordinates.
//    Geocoding that text is unreliable in a way that matters — "Fuglevik, Råde" once resolved to
//    Kristiansand, 230 km away — so every result is checked against the municipality the police
//    stated, and anything that disagrees is dropped rather than guessed.
//
// 3. HOW PRECISELY. Measured bounding boxes: "Skullerud" ~1.1km, "Sentrum" ~2.3km, "Filipstad"
//    ~4.4km. Drawing those as identical dots would invent a corner the police never named. The
//    radius is stored so the map can show the area actually described. Anything vaguer than
//    MAX_RADIUS_M is not worth showing at all.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const POLITILOGGEN = 'https://api.politiloggen.politiet.no/messages';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'SafeWalk/1.0 (neighbourhood safety map; github.com/michaelsivertsennorge/SafeWalk)';

// Nominatim's usage policy: at most 1 request/second, with an identifying User-Agent.
const GEOCODE_DELAY_MS = 1100;
const MAX_GEOCODES_PER_RUN = 15;
const DEFAULT_TTL_HOURS = 12;
const MIN_RADIUS_M = 120;   // even a precise result is not accurate to the metre
const MAX_RADIUS_M = 2500;  // vaguer than this and the circle covers half a city: show nothing

const RELEVANT_CATEGORIES = new Set(['voldshendelse', 'ro og orden']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
};

type Candidate = {
  external_id: string;
  category: string | null;
  municipality: string | null;
  area: string | null;
  text_body: string | null;
  is_active: boolean;
  occurred_at: string | null;
  lat?: number;
  lng?: number;
  radius_m?: number;
  precision_label?: string;
  rejected?: string;
};

async function fetchPolitiloggen(municipality: string, take: number) {
  const url = `${POLITILOGGEN}?Municipalities=${encodeURIComponent(municipality)}&Take=${take}`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Politiloggen ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

function metresBetween(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function geocodeInMunicipality(area: string, municipality: string) {
  const q = `${area}, ${municipality}, Norway`;
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&limit=1&countrycodes=no&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { ok: false as const, why: `nominatim ${res.status}` };
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return { ok: false as const, why: 'no geocode result' };

  const hit = hits[0];
  const a = hit.address || {};
  const claimed = [a.municipality, a.city, a.town, a.county, a.city_district, a.suburb, a.borough]
    .filter(Boolean).map((s: string) => String(s).toLowerCase());
  const want = municipality.toLowerCase();
  // Substring either way: OSM says "Oslo kommune" where the police say "Oslo".
  const agrees = claimed.some((c: string) => c.includes(want) || want.includes(c));
  if (!agrees) return { ok: false as const, why: `resolved to ${claimed.join('/') || 'unknown'}, not ${municipality}` };

  // Half the bounding-box diagonal: the incident is somewhere in that area, not at its centre.
  const bb = (hit.boundingbox || []).map(Number);
  let radius = MIN_RADIUS_M;
  if (bb.length === 4 && bb.every((n: number) => Number.isFinite(n))) {
    radius = Math.round(metresBetween(bb[0], bb[2], bb[1], bb[3]) / 2);
  }
  radius = Math.max(MIN_RADIUS_M, radius);
  if (radius > MAX_RADIUS_M) {
    return { ok: false as const, why: `too vague: "${area}" covers about ${Math.round(radius / 100) / 10}km` };
  }
  return {
    ok: true as const,
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    radius_m: radius,
    precision_label: hit.addresstype || hit.type || 'unknown',
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const dry = url.searchParams.get('dry') === '1';
  const municipality = url.searchParams.get('municipality') || 'Oslo';
  // Politiloggen rejects Take > 50 with a 400.
  const take = Math.min(50, Number(url.searchParams.get('take') || 50));
  const allCategories = url.searchParams.get('allCategories') === '1';

  try {
    const raw = await fetchPolitiloggen(municipality, take);
    const list: any[] = raw?.messages ?? (Array.isArray(raw) ? raw : []);
    if (!Array.isArray(list) || !list.length) {
      return json({ ok: true, municipality, fetched: 0, note: 'no messages returned', shape: Object.keys(raw || {}) });
    }

    const all: Candidate[] = list.map((m: any) => ({
      external_id: String(m.id ?? ''),
      category: m.category ?? null,
      municipality: m.municipality ?? null,
      area: m.area ?? null,
      text_body: m.text ?? null,
      is_active: !!m.isActive,
      occurred_at: m.createdOn ?? null,
    })).filter((c) => c.external_id);

    const relevant = allCategories
      ? all
      : all.filter((c) => RELEVANT_CATEGORIES.has((c.category || '').toLowerCase()));

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: existing } = await admin
      .from('police_events').select('external_id')
      .in('external_id', relevant.map((c) => c.external_id));
    const known = new Set((existing ?? []).map((e: any) => e.external_id));

    // Several messages often share one area ("Sentrum" three times). Geocode each distinct area
    // once: it is the same answer, and Nominatim's rate limit is the scarce resource here.
    const fresh = relevant.filter((c) => !known.has(c.external_id));
    const cache = new Map<string, any>();
    let geocodes = 0;
    for (const c of fresh) {
      const area = (c.area || '').trim();
      if (!area || !c.municipality) { c.rejected = 'no area given'; continue; }
      const key = `${area}|${c.municipality}`;
      if (!cache.has(key)) {
        if (geocodes >= MAX_GEOCODES_PER_RUN) { c.rejected = 'geocode budget reached'; continue; }
        cache.set(key, await geocodeInMunicipality(area, c.municipality));
        geocodes++;
        await sleep(GEOCODE_DELAY_MS);
      }
      const g = cache.get(key);
      if (g.ok) { c.lat = g.lat; c.lng = g.lng; c.radius_m = g.radius_m; c.precision_label = g.precision_label; }
      else { c.rejected = g.why; }
    }

    const placeable = fresh.filter((c) => c.lat !== undefined);
    const dropped = fresh.filter((c) => c.lat === undefined);

    const categoryBreakdown: Record<string, number> = {};
    all.forEach((c) => { const k = c.category || '(none)'; categoryBreakdown[k] = (categoryBreakdown[k] || 0) + 1; });

    if (dry) {
      return json({
        ok: true, dry: true, municipality,
        fetched: all.length, categoryBreakdown,
        relevantAfterCategoryFilter: relevant.length,
        alreadyStored: known.size, geocodeCallsUsed: geocodes,
        wouldInsert: placeable.length, droppedCount: dropped.length,
        sampleInsert: placeable.slice(0, 4).map((c) => ({ area: c.area, category: c.category, lat: c.lat, lng: c.lng, radius_m: c.radius_m, precision: c.precision_label })),
        sampleDropped: dropped.slice(0, 6).map((d) => ({ area: d.area, category: d.category, why: d.rejected })),
      });
    }

    let inserted = 0;
    if (placeable.length) {
      const rows = placeable.map((c) => ({
        external_id: c.external_id,
        category: c.category,
        municipality: c.municipality,
        area: c.area,
        text_body: c.text_body,
        geom: `SRID=4326;POINT(${c.lng} ${c.lat})`,
        radius_m: c.radius_m,
        precision_label: c.precision_label,
        is_active: c.is_active,
        occurred_at: c.occurred_at,
        expires_at: new Date(Date.now() + DEFAULT_TTL_HOURS * 3600_000).toISOString(),
      }));
      const { error } = await admin.from('police_events').upsert(rows, { onConflict: 'external_id' });
      if (error) throw new Error(`insert failed: ${error.message}`);
      inserted = rows.length;
    }

    return json({ ok: true, municipality, fetched: all.length, relevant: relevant.length, inserted, dropped: dropped.length });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 500) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
