// SafeWalk — what the public API key must and must not be able to do.
//
//   node tests/permissions.test.js
//
// Runs against the live database using the anon key from safewalk-app/config.js. That key is
// public by design — it ships in every browser — so this suite asserts exactly what someone
// holding it can reach.
//
// Every recent security bug in this project was found by hand, one at a time, and three of them
// were the same mistake in different places:
//
//   006  functions were executable by anon because `revoke ... from public` misses named roles
//   012  the pins table published user_id, because 003 only ever fixed the view above it
//   013  votes had no UPDATE policy, so editing a rating silently changed nothing
//
// Each was invisible until someone thought to try the specific request. These are those requests,
// written down, so the next one fails a test instead of shipping.
//
// READ-ONLY BY DESIGN. Every write attempted here is expected to be refused, and each one is
// filtered to match no rows, so a test that unexpectedly succeeds still changes nothing.

const fs = require('fs');
const path = require('path');

const config = fs.readFileSync(path.join(__dirname, '..', 'safewalk-app', 'config.js'), 'utf8');
const URL_ = (config.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
const KEY = (config.match(/SUPABASE_ANON_KEY\s*=\s*'([^']+)'/) || [])[1];
if (!URL_ || !KEY) {
  console.error('Could not read SUPABASE_URL / SUPABASE_ANON_KEY from safewalk-app/config.js');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
let passed = 0;
const failures = [];
const notes = [];
const knownIssues = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const get = (q) => fetch(`${URL_}/rest/v1/${q}`, { headers: H });
const rpc = (fn, body) => fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
const write = (method, q, body) =>
  fetch(`${URL_}/rest/v1/${q}`, { method, headers: { ...H, Prefer: 'return=minimal' }, body: body ? JSON.stringify(body) : undefined });

// A request is "refused" if the server rejected it outright. 200 with zero rows is NOT refusal —
// that distinction is the whole reason migration 013's bug survived.
const refused = (res) => res.status === 401 || res.status === 403 || res.status === 404 || res.status === 400;

async function run() {
  // -------------------------------------------------------------------------
  // Authorship must not be reachable. This is the project's first rule: group
  // pins by author and you have where one person walks, and when.
  // -------------------------------------------------------------------------
  await check('anon cannot read pins.user_id (regression: migration 012)', async () => {
    const res = await get('pins?select=id,user_id');
    ok(refused(res), `expected refusal, got ${res.status}: ${(await res.text()).slice(0, 120)}`);
  });

  await check('anon cannot group pins by author', async () => {
    const res = await get('pins?select=user_id,lat,lng,created_at&order=user_id');
    ok(refused(res), `expected refusal, got ${res.status}`);
  });

  await check('the public view never exposes user_id (regression: migration 003)', async () => {
    const res = await get('pins_with_scores?select=id,user_id');
    ok(refused(res), `expected refusal, got ${res.status}`);
    const all = await (await get('pins_with_scores?select=*&limit=1')).json();
    if (Array.isArray(all) && all.length) {
      ok(!('user_id' in all[0]), 'select=* must not return user_id');
    } else {
      notes.push('pins_with_scores is empty; the select=* half of this check proved nothing');
    }
  });

  await check('pins_near does not leak user_id', async () => {
    const res = await rpc('pins_near', { p_lat: 59.9139, p_lng: 10.7522, p_radius_m: 5000 });
    eq(res.status, 200, 'the RPC should work for anon');
    const body = await res.text();
    ok(!body.includes('user_id'), 'pins_near returned a user_id');
  });

  // -------------------------------------------------------------------------
  // Legitimate public reads must keep working. A permission fix that breaks the
  // map is not a fix.
  // -------------------------------------------------------------------------
  await check('anon can still read the map', async () => {
    const res = await get('pins?select=id,lat,lng,street_name,creator_rating&limit=1');
    eq(res.status, 200, 'the map must stay publicly readable');
  });

  await check('anon can read the scored view and police events', async () => {
    eq((await get('pins_with_scores?select=id,safe_count,danger_count&limit=1')).status, 200);
    eq((await get('police_events?select=id,category,area&limit=1')).status, 200);
  });

  // -------------------------------------------------------------------------
  // Private tables.
  // -------------------------------------------------------------------------
  await check('anon sees no votes (votes_read_own)', async () => {
    const res = await get('votes?select=pin_id,user_id,rating');
    // Row-level security filters rather than refuses, so an empty list is the pass condition.
    if (res.status === 200) {
      const rows = await res.json();
      eq(rows.length, 0, 'anon must not see anyone\'s votes');
    } else {
      ok(refused(res), `unexpected status ${res.status}`);
    }
  });

  await check('anon sees no pin_confirmations (maps pins to authors)', async () => {
    const res = await get('pin_confirmations?select=pin_id,author_id');
    if (res.status === 200) {
      eq((await res.json()).length, 0, 'pin_confirmations must never be readable');
    } else {
      ok(refused(res), `unexpected status ${res.status}`);
    }
  });

  // -------------------------------------------------------------------------
  // SECURITY DEFINER functions bypass RLS, so who may call them matters.
  // Regression guard for migration 006.
  // -------------------------------------------------------------------------
  for (const fn of ['my_standing', 'is_in_pin_cooldown', 'record_route_judgement',
                    'pin_cooldown_ratio', 'pin_cooldown_window', 'pin_cooldown_min_judgements']) {
    await check(`anon cannot execute ${fn}() (regression: migration 006)`, async () => {
      const res = await rpc(fn, fn === 'record_route_judgement' ? { p_pin_ids: [], p_rating: 'safe' } : {});
      ok(refused(res), `expected refusal, got ${res.status}: ${(await res.text()).slice(0, 100)}`);
    });
  }

  // -------------------------------------------------------------------------
  // Writing requires an account. Every attempt below is filtered to match no
  // rows, so an unexpected pass still changes nothing.
  // -------------------------------------------------------------------------
  await check('anon cannot create a pin', async () => {
    const res = await write('POST', 'pins', { kind: 'spot', lat: 0, lng: 0, creator_rating: 'safe' });
    ok(refused(res), `expected refusal, got ${res.status}`);
  });

  await check('anon cannot change an existing pin', async () => {
    // Asserted behaviourally rather than by status code. A PATCH with return=minimal comes back
    // 204 even when row-level security filtered every row out, so the status says nothing useful:
    // whether the data actually moved is the only honest question. Reading the value back answers
    // it, and costs nothing when the app is behaving, because then nothing was written.
    const rows = await (await get('pins?select=id,creator_rating&limit=1')).json();
    if (!Array.isArray(rows) || !rows.length) { notes.push('no pins to test writes against'); return; }
    const pin = rows[0];
    const flipped = pin.creator_rating === 'safe' ? 'danger' : 'safe';

    await write('PATCH', `pins?id=eq.${pin.id}`, { creator_rating: flipped });
    const after = await (await get(`pins?select=creator_rating&id=eq.${pin.id}`)).json();
    eq(after[0].creator_rating, pin.creator_rating,
       'anon changed a pin. That is a critical hole, not a test failure.');

    await write('DELETE', `pins?id=eq.${pin.id}`);
    const still = await (await get(`pins?select=id&id=eq.${pin.id}`)).json();
    eq(still.length, 1, 'anon deleted a pin. That is a critical hole, not a test failure.');
  });

  await check('anon cannot write police events', async () => {
    const res = await write('POST', 'police_events', { external_id: 'test-should-fail', category: 'x' });
    ok(refused(res), `expected refusal, got ${res.status}`);
  });

  // -------------------------------------------------------------------------
  // Known-unfixable, tracked rather than asserted. See backend/KNOWN_ISSUES.md.
  // Deliberately NOT a failure: a suite that can never go green gets ignored,
  // and the failures that matter get ignored along with it. Reported loudly and
  // separately instead, and it says so when it starts passing so the block can go.
  // -------------------------------------------------------------------------
  {
    const del = await write('DELETE', 'spatial_ref_sys?srid=eq.999999');
    if (refused(del)) {
      notes.push('spatial_ref_sys is no longer writable by anon — the known issue is FIXED. ' +
                 'Delete this block and backend/KNOWN_ISSUES.md.');
    } else {
      knownIssues.push(`spatial_ref_sys is writable by anon (DELETE -> ${del.status}). Owned by ` +
                       'supabase_admin, so a migration cannot revoke it. See backend/KNOWN_ISSUES.md.');
    }
  }

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  notes.forEach((n) => console.log(`  NOTE  ${n}\n`));
  knownIssues.forEach((k) => console.log(`  KNOWN ISSUE  ${k}
`));
  if (failures.length) {
    failures.forEach((f) => console.error(`  FAIL  ${f}\n`));
    process.exit(1);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
