// SafeWalk — Politiloggen sync
//
// Mirrors Norwegian police incident reports (politiet.no, NLOD 2.0) into police_events.
//
// Runs server-side for two reasons: Politiloggen blocks CORS, and writing to police_events needs
// the service role. Clients only ever read that table.
//
// Four judgements do most of the work, all measured rather than assumed.
//
// 1. WHICH INCIDENTS COUNT. Politiloggen is mostly traffic and fires. Across 50 Oslo messages:
//    21 Trafikk, 13 Brann, 6 Savnet, 5 Andre hendelser, 3 Voldshendelse, 2 Ro og orden. A car
//    crash does not make a street unsafe to walk down, and painting the map red for one would
//    bury the incidents that do. Only categories bearing on personal safety on foot are mirrored.
//
// 2. WHERE IT HAPPENED. The structured `area` field is often a whole district: "Gamlebyen"
//    geocodes to a 2.5km circle. But the officer writing the free text usually names the actual
//    street, so the text is mined for one first. Measured on real data: the same Gamlebyen
//    incident goes from a 2488m blob to a 120m road once "Valhallveien" is pulled out of the text.
//
// 3. WHETHER TO TRUST THE GEOCODE. Free text is unreliable in a way that matters — "Fuglevik,
//    Råde" once resolved to Kristiansand, 230 km away. Every result is checked against the
//    municipality the police stated, street lookups must actually resolve to a road, and anything
//    vaguer than MAX_RADIUS_M is dropped rather than drawn as a misleading blob.
//
// 4. HOW LONG IT MATTERS. Politiloggen says whether an operation is still running. An ongoing one
//    stays up; a finished one is history within a few hours. Expiry is measured from the incident
//    itself, not from when we synced it — otherwise the hourly cron keeps renewing an old
//    incident's lease and it never disappears. Anything already past its expiry is skipped
//    before geocoding, because geocode budget is the scarce resource and spending it on stale
//    reports starves the fresh ones.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const POLITILOGGEN = 'https://api.politiloggen.politiet.no/messages';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'SafeWalk/1.0 (neighbourhood safety map; github.com/michaelsivertsennorge/SafeWalk)';

// Nominatim's usage policy: at most 1 request/second, with an identifying User-Agent.
const GEOCODE_DELAY_MS = 1100;
const MAX_GEOCODES_PER_RUN = 20;

// See judgement 4. Ongoing operations persist; finished ones fade quickly.
const ACTIVE_TTL_HOURS = 24;    // safety net: if the feed stalls, nothing sticks around past a day
const RESOLVED_TTL_HOURS = 6;   // long enough to still matter on tonight's walk home

const MIN_RADIUS_M = 120;       // even a precise result is not accurate to the metre
const MAX_RADIUS_M = 2500;      // vaguer than this and the circle covers half a city

const RELEVANT_CATEGORIES = new Set(['voldshendelse', 'ro og orden']);

// Norwegian street-name endings. Deliberately conservative: a false street is worse than none,
// because it moves the warning somewhere the police never mentioned.
const STREET_SUFFIXES = 'veien|vegen|gata|gaten|gate|vei|plassen|stien|bakken|brua|broen|alleen|alléen|torget|kaia|svingen|løkka|parken';
// The escaping here matters and was wrong until 2026-09-06. Inside a template literal "\b" is the
// backspace character, not a word boundary, so the pattern began with a literal U+0008 and could
// never match anything. Street extraction had therefore returned null for every message ever
// synced — the database had zero events located by street, all of them district-sized blobs —
// while the comment above claimed the feature worked. It needs "\b" to reach the regex as \b.
// The class carries ü and é as well: Grünerbrua and Bygdøy allé are ordinary Oslo street names.
const STREET_RE = new RegExp(`\\b([A-ZÆØÅ][a-zæøåüéA-ZÆØÅÜÉ-]*(?:${STREET_SUFFIXES}))\\b`, 'g');

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
  search_text?: string | null;   // every message in the thread, for street extraction
  last_update_at?: string | null; // newest message, for expiry
  message_count?: number;
  is_active: boolean;
  occurred_at: string | null;
  lat?: number;
  lng?: number;
  radius_m?: number;
  precision_label?: string;
  located_by?: string;
  street_guess?: string | null;
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

function extractStreet(text: string | null): string | null {
  if (!text) return null;
  STREET_RE.lastIndex = 0;
  const found = [...text.matchAll(STREET_RE)].map((m) => m[1]);
  return found.length ? found[0] : null;
}

// A regex that never matches is indistinguishable from "the police did not name a street" — which
// is exactly how the escaping bug above survived for the whole life of the feature, quietly
// turning every incident into a district-sized blob while the code looked correct. So prove the
// pattern still works on real phrasing every run, and report it in the sync's own output rather
// than throwing: a broken extractor should be loud, but it should not take down area-based
// placement, which still puts the incident roughly in the right part of town.
const STREET_EXTRACTION_OK =
  extractStreet('Vi og ambulanse er ved et utested i Rådhusgata etter melding om slagsmål.') === 'Rådhusgata' &&
  extractStreet('Ingen gate nevnt her i det hele tatt.') === null;

type GeoHit = { lat: number; lng: number; radius_m: number; precision_label: string; isRoad: boolean };

async function geocode(query: string, municipality: string): Promise<{ ok: true; hit: GeoHit } | { ok: false; why: string }> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=no&addressdetails=1`;
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) return { ok: false, why: `nominatim ${res.status}` };
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return { ok: false, why: 'no result' };

  const hit = hits[0];
  const a = hit.address || {};
  const claimed = [a.municipality, a.city, a.town, a.county, a.city_district, a.suburb, a.borough]
    .filter(Boolean).map((s: string) => String(s).toLowerCase());
  const want = municipality.toLowerCase();
  // Substring either way: OSM says "Oslo kommune" where the police say "Oslo".
  if (!claimed.some((c: string) => c.includes(want) || want.includes(c))) {
    return { ok: false, why: `resolved to ${claimed.join('/') || 'unknown'}, not ${municipality}` };
  }

  const bb = (hit.boundingbox || []).map(Number);
  let radius = MIN_RADIUS_M;
  if (bb.length === 4 && bb.every((n: number) => Number.isFinite(n))) {
    radius = Math.round(metresBetween(bb[0], bb[2], bb[1], bb[3]) / 2);
  }
  radius = Math.max(MIN_RADIUS_M, radius);

  const label = hit.addresstype || hit.type || 'unknown';
  const isRoad = hit.category === 'highway' || ['road', 'residential', 'street', 'highway'].includes(String(label));
  return { ok: true, hit: { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon), radius_m: radius, precision_label: label, isRoad } };
}

// Try the most specific phrasing first and stop at the first trustworthy answer.
async function locate(c: Candidate, budget: { left: number }) {
  const muni = c.municipality!;
  const area = (c.area || '').trim();
  const street = extractStreet(c.search_text ?? c.text_body);
  c.street_guess = street;

  const attempts: Array<{ q: string; via: string; mustBeRoad: boolean }> = [];
  if (street && area) attempts.push({ q: `${street}, ${area}, ${muni}, Norway`, via: 'street+area', mustBeRoad: true });
  if (street) attempts.push({ q: `${street}, ${muni}, Norway`, via: 'street', mustBeRoad: true });
  if (area) attempts.push({ q: `${area}, ${muni}, Norway`, via: 'area', mustBeRoad: false });

  if (!attempts.length) { c.rejected = 'no area and no street in text'; return; }

  const reasons: string[] = [];
  for (const a of attempts) {
    if (budget.left <= 0) { c.rejected = 'geocode budget reached'; return; }
    budget.left--;
    const r = await geocode(a.q, muni);
    await sleep(GEOCODE_DELAY_MS);
    if (!r.ok) { reasons.push(`${a.via}: ${r.why}`); continue; }
    // A street query that resolves to a whole suburb has not found the street.
    if (a.mustBeRoad && !r.hit.isRoad) { reasons.push(`${a.via}: resolved to ${r.hit.precision_label}, not a road`); continue; }
    if (r.hit.radius_m > MAX_RADIUS_M) { reasons.push(`${a.via}: too vague (~${Math.round(r.hit.radius_m / 100) / 10}km)`); continue; }
    c.lat = r.hit.lat; c.lng = r.hit.lng; c.radius_m = r.hit.radius_m;
    c.precision_label = r.hit.precision_label; c.located_by = a.via;
    return;
  }
  c.rejected = reasons.join(' | ') || 'no usable location';
}

// Measured from the newest message in the thread, not from when the incident started. An operation
// the police are still posting updates about at 03:00 is still happening, whatever time it began;
// counting from the first message would quietly retire it mid-incident.
function expiryMs(c: Candidate): number {
  const hours = c.is_active ? ACTIVE_TTL_HOURS : RESOLVED_TTL_HOURS;
  const stamp = c.last_update_at ?? c.occurred_at;
  const base = stamp ? new Date(stamp).getTime() : Date.now();
  return base + hours * 3600_000;
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
      return json({ ok: true, municipality, fetched: 0, note: 'no messages returned' });
    }

    // Politiloggen posts an incident as a THREAD: the first message reports it, later ones update
    // it, and the last usually says it is over. Keying on the message id made each update its own
    // red zone — measured on a real Oslo feed, 50 messages were only 22 incidents, and the two
    // categories we show were 5 messages for 3 events. That drew one fight as two warnings, and a
    // "the cordon has been lifted" update as a brand new hazard.
    //
    // So collapse each thread to one incident, keyed on the thread. Which message supplies what
    // matters: the newest carries the current status and the text worth reading, the first carries
    // when it happened and usually the only mention of the street ("Vi er i Rådhusgata..." — later
    // updates rarely repeat it), so street extraction searches the whole thread.
    const threads = new Map<string, any[]>();
    for (const m of list) {
      const key = String(m.threadId ?? m.id ?? '');
      if (!key) continue;
      if (!threads.has(key)) threads.set(key, []);
      threads.get(key)!.push(m);
    }

    const all: Candidate[] = [...threads.entries()].map(([threadId, msgs]) => {
      const ordered = msgs.slice().sort((a, b) =>
        new Date(a.createdOn ?? 0).getTime() - new Date(b.createdOn ?? 0).getTime());
      const first = ordered[0];
      const latest = ordered[ordered.length - 1];
      return {
        external_id: threadId,
        category: latest.category ?? first.category ?? null,
        municipality: latest.municipality ?? first.municipality ?? null,
        area: first.area ?? latest.area ?? null,
        text_body: latest.text ?? null,
        search_text: ordered.map((m: any) => m.text ?? '').filter(Boolean).join(' \n'),
        // The police clear isActive on the final message, so the newest one is the live status.
        is_active: !!latest.isActive,
        occurred_at: first.createdOn ?? null,
        last_update_at: latest.createdOn ?? first.createdOn ?? null,
        message_count: ordered.length,
      };
    }).filter((c) => c.external_id && c.municipality);

    const byCategory = allCategories
      ? all
      : all.filter((c) => RELEVANT_CATEGORIES.has((c.category || '').toLowerCase()));

    // Drop anything already past its lifetime BEFORE spending any geocode calls on it.
    const now = Date.now();
    const relevant = byCategory.filter((c) => expiryMs(c) > now);
    const tooOld = byCategory.length - relevant.length;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Re-sync anything still active so its status and expiry stay current; skip settled ones we
    // already have, since nothing about them will change again.
    const { data: existing } = await admin
      .from('police_events').select('external_id,is_active')
      .in('external_id', relevant.map((c) => c.external_id));
    const settled = new Set((existing ?? []).filter((e: any) => !e.is_active).map((e: any) => e.external_id));

    const todo = relevant.filter((c) => !settled.has(c.external_id));
    const budget = { left: MAX_GEOCODES_PER_RUN };
    for (const c of todo) await locate(c, budget);

    const placeable = todo.filter((c) => c.lat !== undefined);
    const dropped = todo.filter((c) => c.lat === undefined);

    if (dry) {
      const categoryBreakdown: Record<string, number> = {};
      all.forEach((c) => { const k = c.category || '(none)'; categoryBreakdown[k] = (categoryBreakdown[k] || 0) + 1; });
      return json({
        ok: true, dry: true, municipality, streetExtraction: STREET_EXTRACTION_OK ? 'ok' : 'BROKEN',
        messages: list.length, incidents: all.length, categoryBreakdown,
        afterCategoryFilter: byCategory.length, skippedTooOld: tooOld,
        stillRelevant: relevant.length, alreadySettled: settled.size,
        geocodeCallsUsed: MAX_GEOCODES_PER_RUN - budget.left,
        wouldWrite: placeable.length, droppedCount: dropped.length,
        located: placeable.map((c) => ({
          area: c.area, street_guess: c.street_guess, located_by: c.located_by, updates: c.message_count,
          radius_m: c.radius_m, precision: c.precision_label,
          is_active: c.is_active, expires_at: new Date(expiryMs(c)).toISOString(),
        })),
        dropped: dropped.map((d) => ({ area: d.area, street_guess: d.street_guess, why: d.rejected })),
      });
    }

    let written = 0;
    if (placeable.length) {
      const rows = placeable.map((c) => ({
        external_id: c.external_id,
        category: c.category,
        municipality: c.municipality,
        area: c.area,
        text_body: c.text_body,
        geom: `SRID=4326;POINT(${c.lng} ${c.lat})`,
        radius_m: c.radius_m,
        precision_label: c.located_by === 'area' ? c.precision_label : `street:${c.precision_label}`,
        is_active: c.is_active,
        occurred_at: c.occurred_at,
        expires_at: new Date(expiryMs(c)).toISOString(),
      }));
      const { error } = await admin.from('police_events').upsert(rows, { onConflict: 'external_id' });
      if (error) throw new Error(`upsert failed: ${error.message}`);
      written = rows.length;
    }

    return json({ ok: true, municipality, streetExtraction: STREET_EXTRACTION_OK ? 'ok' : 'BROKEN', messages: list.length, incidents: all.length, relevant: relevant.length, skippedTooOld: tooOld, written, dropped: dropped.length });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 500) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
