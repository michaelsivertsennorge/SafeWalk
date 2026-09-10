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
//    21 Trafikk, 12 Brann, 6 Savnet, 6 Andre hendelser, 3 Voldshendelse, 2 Ro og orden. A car
//    crash does not make a street unsafe to walk down, and painting the map red for one would
//    bury the incidents that do. Violence and public order are always mirrored. "Andre hendelser"
//    is admitted only when the thread describes something blocking the way and it is not yet
//    lifted — see isBlockingIncident. Fires are mostly burnt cooking, and missing-person reports
//    are deliberately excluded: someone who is missing is not a hazard to a passer-by, and
//    drawing a red circle around them would be both wrong and unkind.
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

// "Andre hendelser" is the awkward one. It is where the police put a cordoned-off pavement after
// grenades were found in Akerselva — precisely the "ongoing operation near you" this app is for —
// but also press logistics for a royal funeral. Taking the whole category would put announcements
// about next Wednesday's road closures on the map as though they were happening now.
//
// So it is admitted only when the thread actually describes something blocking the way, and only
// while it is still blocked. Two things this must NOT rely on:
//
//   - Politiloggen's `isActive`. It does not mean "still happening". Measured on a live feed, only
//     3 of 50 messages had it set, all of them standing royal-visit notices, while every message
//     of the grenade cordon — including "the pavement WILL BE cordoned off" — had it false.
//   - The first message alone. The cordon being lifted is announced in the last one.
//
// Regex literals, not `new RegExp` on a template string: that is what silently broke STREET_RE.
const CORDON_RE = /avsperr|sperret av|sperring|stengt|evakuer|hold avstand/i;
const LIFTED_RE = /opphevet|gjenåpnet|åpnet igjen|avsluttet|normal ferdsel|ikke lenger/i;
const MEDIA_AREA_RE = /media/i;

// A blocked route matters to someone on foot; the same thread once the block is gone does not.
function isBlockingIncident(c: Candidate): boolean {
  if (!CORDON_RE.test(c.search_text ?? c.text_body ?? '')) return false;
  if (LIFTED_RE.test(c.text_body ?? '')) return false;        // newest message says it is over
  if (MEDIA_AREA_RE.test(c.area ?? '')) return false;         // press notice, not an incident
  return true;
}

// Norwegian street-name endings. Deliberately conservative: a false street is worse than none,
// because it moves the warning somewhere the police never mentioned.
const STREET_SUFFIXES = 'veien|vegen|gata|gaten|gate|vei|plassen|stien|bakken|brua|broen|alleen|alléen|torget|kaia|svingen|løkka|parken';
// The escaping here matters and was wrong until 2026-09-06. Inside a template literal "\b" is the
// backspace character, not a word boundary, so the pattern began with a literal U+0008 and could
// never match anything. Street extraction had therefore returned null for every message ever
// synced — the database had zero events located by street, all of them district-sized blobs —
// while the comment above claimed the feature worked. It needs "\\b" in the source to reach
// the regex engine as \b.
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

// Same reasoning for the cordon rule: silently matching nothing would just look like a quiet week.
const CORDON_RULE_OK = (() => {
  const cordon = { area: 'Grünerbrua', text_body: 'Fortauet er avsperret.', search_text: 'Fortauet er avsperret.' } as Candidate;
  const lifted = { area: 'Grünerbrua', text_body: 'Sperringene er opphevet.', search_text: 'Fortauet er avsperret. Sperringene er opphevet.' } as Candidate;
  const press = { area: 'Slottet. Media', text_body: 'Flere veier blir stengt.', search_text: 'Flere veier blir stengt.' } as Candidate;
  const quiet = { area: 'Sentrum', text_body: 'Ingenting spesielt.', search_text: 'Ingenting spesielt.' } as Candidate;
  return isBlockingIncident(cordon) && !isBlockingIncident(lifted)
      && !isBlockingIncident(press) && !isBlockingIncident(quiet);
})();

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
        // Passed through as the police report it, but do not read it as "still happening": on a
        // live feed only 3 of 50 messages had it set, all standing royal-visit notices, while
        // every message of an active grenade cordon had it false. Whether a route is still
        // blocked is decided from the text instead — see isBlockingIncident.
        is_active: !!latest.isActive,
        occurred_at: first.createdOn ?? null,
        last_update_at: latest.createdOn ?? first.createdOn ?? null,
        message_count: ordered.length,
      };
    }).filter((c) => c.external_id && c.municipality);

    const byCategory = allCategories
      ? all
      : all.filter((c) => {
          const cat = (c.category || '').toLowerCase();
          if (RELEVANT_CATEGORIES.has(cat)) return true;
          return cat === 'andre hendelser' && isBlockingIncident(c);
        });

    // Drop anything already past its lifetime BEFORE spending any geocode calls on it.
    const now = Date.now();
    const relevant = byCategory.filter((c) => expiryMs(c) > now);
    const tooOld = byCategory.length - relevant.length;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Re-sync anything still active so its status and expiry stay current; skip settled ones we
    // already have, since nothing about them will change again.
    //
    // Both lookups below used to leave their `error` on the floor: a failed request read exactly
    // like an empty table, which is a safe *shape* (undefined coerces to [] via `?? []`) but not a
    // safe *meaning* for the second one — see next comment. Neither is allowed to fail invisibly
    // now; both are reported in the JSON output, the same way streetExtraction/cordonRule are.
    const { data: existing, error: existingErr } = await admin
      .from('police_events').select('external_id,is_active')
      .in('external_id', relevant.map((c) => c.external_id));
    if (existingErr) console.error(`police_events settled-lookup failed: ${existingErr.message}`);
    const settled = new Set((existing ?? []).filter((e: any) => !e.is_active).map((e: any) => e.external_id));

    // Incidents we have already decided we cannot place well enough to draw. Without this the same
    // doomed lookup is sent to Nominatim every hour forever — observed in the live logs as
    // Kristiansand and Bærum reporting "relevant 1, dropped 1" on every run, indefinitely. Nominatim
    // is free and asks not to be queried systematically, and a 429 from it costs us the incidents we
    // could have placed.
    //
    // A failed read here is the more dangerous of the two: `gaveUpAt` would come back empty, which
    // reads exactly like "we have never given up on any of these" — silently reintroducing the
    // hammer-Nominatim-forever bug this table exists to stop, with no sign anything went wrong.
    const { data: failures, error: failuresErr } = await admin
      .from('police_geocode_failures').select('external_id,message_count')
      .in('external_id', relevant.map((c) => c.external_id));
    if (failuresErr) console.error(`police_geocode_failures lookup failed: ${failuresErr.message}`);
    const gaveUpAt = new Map((failures ?? []).map((f: any) => [f.external_id, f.message_count ?? 1]));

    const todo = relevant.filter((c) => {
      if (settled.has(c.external_id)) return false;
      const seen = gaveUpAt.get(c.external_id);
      // A thread that has gained a message since is worth another try: the update often names the
      // street the first message left out, which is the whole reason street extraction exists.
      return seen === undefined || (c.message_count ?? 1) > seen;
    });
    const skippedGivenUp = relevant.length - todo.length - settled.size;
    const budget = { left: MAX_GEOCODES_PER_RUN };
    for (const c of todo) await locate(c, budget);

    const placeable = todo.filter((c) => c.lat !== undefined);
    const dropped = todo.filter((c) => c.lat === undefined);

    if (dry) {
      const categoryBreakdown: Record<string, number> = {};
      all.forEach((c) => { const k = c.category || '(none)'; categoryBreakdown[k] = (categoryBreakdown[k] || 0) + 1; });
      return json({
        ok: true, dry: true, municipality, streetExtraction: STREET_EXTRACTION_OK ? 'ok' : 'BROKEN', cordonRule: CORDON_RULE_OK ? 'ok' : 'BROKEN',
        settledLookup: existingErr ? `failed: ${existingErr.message}` : 'ok',
        failuresLookup: failuresErr ? `failed: ${failuresErr.message}` : 'ok',
        messages: list.length, incidents: all.length, categoryBreakdown,
        afterCategoryFilter: byCategory.length, skippedTooOld: tooOld,
        stillRelevant: relevant.length, alreadySettled: settled.size, skippedGivenUp,
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

    // Remember what we could not place, so the next run does not ask Nominatim the same question.
    // This write failing silently would be worse than never having this table: it would look
    // exactly like a normal run while quietly restoring the hammer-Nominatim-every-hour bug that
    // migration 015/016 exists to prevent, invisibly, from the very next invocation onward. So it
    // is checked and thrown like the police_events upsert above, not fire-and-forget.
    if (dropped.length) {
      const { error: failuresWriteErr } = await admin.from('police_geocode_failures').upsert(
        dropped.map((c) => ({
          external_id: c.external_id,
          municipality: c.municipality,
          area: c.area,
          reason: (c.rejected || 'no usable location').slice(0, 300),
          message_count: c.message_count ?? 1,
          tried_at: new Date().toISOString(),
        })),
        { onConflict: 'external_id' },
      );
      if (failuresWriteErr) throw new Error(`police_geocode_failures upsert failed: ${failuresWriteErr.message}`);
    }

    return json({
      ok: true, municipality, streetExtraction: STREET_EXTRACTION_OK ? 'ok' : 'BROKEN', cordonRule: CORDON_RULE_OK ? 'ok' : 'BROKEN',
      settledLookup: existingErr ? `failed: ${existingErr.message}` : 'ok',
      failuresLookup: failuresErr ? `failed: ${failuresErr.message}` : 'ok',
      messages: list.length, incidents: all.length, relevant: relevant.length, skippedTooOld: tooOld, skippedGivenUp, written, dropped: dropped.length,
    });
  } catch (err) {
    return json({ ok: false, error: String(err).slice(0, 500) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
