# SafeWalk roadmap

What's wanted next, roughly in priority order. The hourly maintenance agent should pick **one**
item, do it properly, and open a PR — not sweep through several.

## Asked for by the owner

### Visual design: pastel palette and themes — **done, first pass**
Four themes ship: Midnight (the original), Blossom (pastel light), Dusk (pastel dark) and Contrast.
Picker lives in My Page; choice is stored per-device in `localStorage`. Every colour in the app is
now a CSS custom property, including the ones Leaflet draws on the map, so a theme is purely a new
set of token values — no per-theme stylesheet, no rebuild.

Measured, not assumed: all four themes pass WCAG AA (4.5:1) for body text, dim text, and all three
rating colours used as text. Blossom's amber started at 3.43:1 and was darkened to 5.25:1 because
`ratingColor()` is used as *text* on the pin score, where the 3:1 allowance for graphical objects
does not apply.

Still worth doing here:
- Buttons: the "prettier buttons" ask is done, and this entry was stale. The bottom bar is
  whole-coloured pastel with no icons, as asked; primary actions are filled, and an audit of all 41
  buttons across all 11 sheets on 2026-09-08 found three deliberate corner radii (9/12/14px) and no
  overflow at 375px.
  That audit did find something this file had been claiming was already true: six controls were
  under the 44px touch minimum — the "Just this spot"/"Whole street" and "Walking"/"Biking" toggles
  at 36px, and both map-pin buttons at 42px. Those are the choice between marking a spot and
  marking a whole street, tapped one-handed in the dark. All 41 now meet it.
  That audit was buttons only, and saying "all 41 now meet it" hid the fact that nothing else had
  been measured. On 2026-09-08 every text input turned out to be 42px — including the email and
  password fields on the sign-in screen, the first two things a new user ever taps. One
  `min-height: 44px` on the shared input rule fixed all twelve at once; verified by measuring each
  one in the browser at 375px, with the nested hidden forms opened so none reported a false zero.
- No per-theme testing on a real phone outdoors yet.
- Rating colours must keep their dash patterns (solid / dashed / dotted). That redundant encoding is
  what makes the map readable for colourblind users, and no palette change may drop it.

### My Page is a hub of four sections — **done, 2026-09-08**
Asked for by the owner. My Page used to be one long scroll: account, standing, a My-reports button,
theme, accent, preferences, emergency contact, clear-data, version. The emergency contact — the one
thing you might need in a hurry — sat near the bottom, under the theme picker.

It is now a hub of four rooms, each a sheet of its own: **Profile**, **My reports & marks**,
**Emergency contact**, **Theme**. Each hub row carries a one-line summary of what is inside, which
is where the real gain is: "Not set yet — SOS has nobody to call" is visible without opening
anything, so you find out before the night you need it rather than during. Every sub-sheet has a
Back that returns to the hub, because only one sheet is ever open at a time and Close drops you on
the map.

**Changing your password** now lives in Profile, and asks for the current one first. Supabase would
change a password from the session alone; this app gets opened one-handed on an unlocked phone at
night, so the case where somebody else is holding that phone is the case the flow has to survive.
Verifying the old password first means a stolen unlocked phone cannot lock the owner out.

The restructure moved markup without renaming a single element, so every existing handler kept
working. Verified in the browser at 375px, not by reading: all four rooms open and return, only one
sheet is ever open, the hub summaries render, the password section is hidden when signed out and
shown when signed in, and all four validation refusals fire with their own message. **Not verified:
an actual password change against Supabase** — that needs a real account and a real current
password, so the two network calls (`signInWithPassword` to re-authenticate, then `updateUser`) have
been read but never run. Worth doing once on a throwaway account before this is sold.

**Resetting a forgotten password** was added the same day, because the change form requiring the old
password left anyone who had forgotten it with no way back into their account. "Forgot your
password?" on the sign-in sheet sends a link via `resetPasswordForEmail`; following it fires
`PASSWORD_RECOVERY`, which opens a sheet that asks only for the new password twice — the link itself
is the proof of address, so there is nothing else to prove.

Two details are not obvious and are easy to break:
- The reply is identical whether or not the address has an account. Confirming an address would turn
  the button into a way to test whether a given person uses SafeWalk, and on this app that leaks
  something about where they walk.
- Supabase turns the recovery token into a real session *before* the app sees it. Handling
  `PASSWORD_RECOVERY` is therefore not optional: without it the link signs someone in and leaves
  them exactly where they started — no memory of the password, and a form demanding it. Because that
  sheet can be dismissed, `inPasswordRecovery` also reshapes the Profile form for the rest of the
  session, so the same dead end cannot be reached the long way round.

Verified in the browser: the forgot link appears on sign-in and disappears on create-account, an
empty address is refused locally without sending anything, all three reset-form refusals fire, and
recovery mode hides the current-password field and stops the save demanding it while normal mode
still does. **Not verified: any of the actual email round-trip** — sending a real link needs a real
inbox, and no reset email has been sent from this session. What has to be true for it to work at
all, in the Supabase dashboard under Authentication → URL Configuration:
- Redirect URLs must include `https://michaelsivertsennorge.github.io/SafeWalk/`
- Site URL must be that too, not the `http://localhost:3000` a new project defaults to
If either is wrong the email still arrives and the link still works — it just lands somewhere that
is not SafeWalk, which looks like the reset silently failing.

Still open here:
- No rate-limit feedback beyond a generic retry message, and Supabase's own limit on reset emails is
  per-hour. Someone tapping twice will be told to wait a minute, which may understate it. The bullet
  below narrows this a little: an accidental rapid double-tap, the likelier case, no longer sends two
  requests before either reply lands.

### Auth-sheet buttons could double-submit — fixed 2026-09-09
The 2026-09-08 duplicate-submit audit (see "one press cannot file twelve reports") checked every
button that writes a pin, vote or walk row, and wrapped the one it found unsafe (`startWatchedWalkBtn`)
in `onceAtATime()`. It did not check the auth sheet, whose four async handlers —
sign in/sign up, forgot password, change password, set a new password after a reset link — were
already wrapped in `guarded()`. That only turns a thrown error into a status message; it has no
re-entrancy guard, so a second tap while the first was still awaiting Supabase ran a second, racing
request. Concretely: a double-tap on "Send reset link" sent two emails before either reply landed,
eating into Supabase's per-hour reset-email limit on a single accidental tap rather than the
deliberate repeated one the line above assumes; a double-tap on sign-up raced two `signUp()` calls.

All four are now also wrapped in `onceAtATime()`, the same fix already applied to
`startWatchedWalkBtn`, `deleteAccountBtn` and the incident vote buttons — a second tap while the
first is in flight is now a no-op rather than a second request.

**Not verified: any of it against live Supabase.** The fix is a direct application of a pattern
already proven elsewhere in this file (`onceAtATime` has its own coverage in the duplicate-submit
audit above), and `node tests/geo.test.js` still passes (105 assertions, unaffected — this is DOM
event wiring, not geometry), but nobody has driven a real double-tap through the auth sheet in a
browser against a real Supabase project to watch it produce one request instead of two.

### Walk mode — **done, 2026-09-08**
Asked for by the owner, from the right observation: the app was built for marking places from a map,
but the real use is picking a route and then rating it *while walking it*.

Marking from an armchair and marking mid-walk are different problems. At home the hard part is
**where** — tap the map, aim at a road, choose spot or street. While walking, the app already knows
where you are, so the only thing left to say is how it felt. That is one bit, and it costs one
press: no aiming, no reading, no precision.

Three decisions follow, none of them cosmetic:

- **A mark covers the stretch just walked, not a point.** Nobody stops mid-street to rate it — you
  keep going and reach for the phone once you are past, so a point dropped at the moment of the tap
  is already tens of metres wrong *and* says the wrong thing. 100m of route behind you is both what
  you meant and what survives a GPS fix that is 20m out.
- **A press votes on an existing pin where there is one**, and only creates a new one where there is
  not. Better evidence, since agreement concentrates instead of scattering — and the stronger
  privacy position, because votes are readable only by their author. A walk through a well-covered
  area therefore adds *nothing* to the public map.
- **A press is not written for four seconds.** A misfire in a pocket is likelier than a considered
  tap, and an undo that has to reach the database to take something back has already left a trace.
  Anything pending is flushed on `pagehide`, so locking the phone commits the mark rather than
  losing it.

The bar sits exactly where the bottom bar sits and replaces it, so the thumb goes where it already
knows. Two targets, 72px — deliberately past the 44px minimum, because this is pressed while moving.
It does **not** flash or change colour on a press: someone marking a stretch may be walking past the
reason they are marking it, and a screen that lights up red announces what they just did. The
confirmation is haptic.

Two bugs found by testing rather than by reading, both of the house speciality:
- With no GPS fix, `walkState.index` is still 0, so a press marked the **start of the route** as
  though it had been walked — a false warning about a street the person may never have set foot on.
  It now refuses and says why.
- The geolocation error handler overwrote the undo line, which is time-limited and the only way back
  from a misfire.

Verified in the browser by driving the buttons through a simulated walk: the bar replaces the bottom
bar and restores it, a press writes nothing until the window closes, undo writes nothing at all, a
committed mark creates a *street* pin spanning six route vertices, an existing foreign pin gets a
vote and no new row, a repeat press on the same stretch is refused with the right message for a pin
that is yours versus someone else's, being 400m off route is refused, and no-fix is refused. The
pure geometry has nine tests in `tests/geo.test.js` (82 assertions total), including the one that
matters most: `routeProgress` searching forward so an out-and-back route does not snap the return
leg onto the outbound one and mark the wrong half.

**Not verified: any of it in motion.** Every position above was set by hand. Walking an actual route
outdoors, with real GPS drift and a real phone, is the only thing that settles whether 100m and 120m
are the right numbers.

Still open here:
- Arrival is still the existing whole-route verdict rather than a street-by-street list. Finishing a
  walk lands on it, which is the right place, but "Storgata, Torggata, Youngs gate — anything feel
  off?" would catch more of the people who never touched the phone.
- No street name on a walk mark, so they show as unnamed stretches. Reverse-geocoding each one would
  be a Nominatim call per press, which its usage policy does not allow.

### Still open
- **Politiloggen — shipped, first pass.** Police incidents now sync hourly via the
  `politiloggen-sync` edge function and show on the map as dashed red areas. See
  `backend/functions/politiloggen-sync/README.md` for what it decides and why.

  **The layer no longer fails silently — fixed 2026-09-08.** `loadPoliceEvents` ran once, at page
  load, and its failure path was `if (error || !Array.isArray(data)) return;` — no log, no legend,
  no retry. So a dropped connection meant no police layer *and* no proximity warning for as long as
  the app stayed open, which on a walk home may be until morning. Worse, it failed towards
  reassurance: "no police reports near you" and "we could not find out" were the same screen, a map
  with no red on it, and the comforting reading was the wrong one. The map key now distinguishes
  checking / none active / could not be loaded, and the layer re-fetches every five minutes.
  Verified by simulating an outage in the browser and watching the key change, not by reading it.

  This was the single most-reported item in the project's history: the hourly agent opened five
  separate PRs for it (#3, #4, #6, #10, #12) because none of them ever merged and every fresh run
  found it again. It is fixed on main now, so the roadmap and the code finally agree.

  Still open here:
  - **Street extraction now works — it never had before.** The regex was built with a template
    literal where `\b` is the backspace character rather than a word boundary, so the pattern
    began with U+0008 and could not match anything. Every incident ever synced was therefore
    placed by its district name, which is why the database had zero events at street precision.
    Fixed, and the function now proves the pattern on known phrasing every run and reports
    `streetExtraction: "ok"` in its own output, because a regex that never matches is
    indistinguishable from "the police did not name a street".
  - **Incidents are threads, and each update used to become its own red zone.** Politiloggen
    posts an incident then updates it, the last message usually saying it is over. Keying on the
    message id drew one fight as two warnings and turned "the cordon has been lifted" into a
    fresh hazard. Now collapsed by `threadId`: measured live, 50 messages are 22 incidents.
  - **The layer is empty almost all the time, and that is now the main open question.** Over four
    days of real Oslo data the 50 most recent messages held only 3 `Voldshendelse` and 2
    `Ro og orden`. With a 6-hour resolved TTL there is essentially never anything to show. The
    honest options are a longer TTL, or widening the categories. `Andre hendelser` is the
    interesting one: it carried a cordoned-off pavement at Grünerbrua after grenades were found
    in Akerselva — exactly the "ongoing operation near you" the owner asked for — but it also
    carries pure media notices about royal-visit road closures. `Brann` is mostly burnt cooking.
    `Trafikk` is car-on-car. `Savnet` should stay out: a missing person is not a hazard to a
    passer-by, and drawing a red zone around one would be wrong. Needs a decision from the owner.
  - **Nominatim has real gaps in Norwegian coverage.** `Økern`, a well-known Oslo district, returns
    no result at all, so those incidents are skipped. Verified it is not rate-limiting — `Skullerud`
    succeeds in the same second.
  - Only `Voldshendelse` and `Ro og orden` are mirrored. Revisit whether `Andre hendelser` is worth
    including once there is a feel for what it contains.
  - Police events are shown but deliberately NOT folded into the route score. An official report is
    evidence a person should weigh themselves, and silently moving a route because of one would hide
    the reason. Worth revisiting with real usage.
- **Google sign-in** alongside email/password. Needs Google Cloud console setup.
- **Reputation: the mechanism is verified, the numbers are still a guess.** `backend/tests/reputation.sql`
  was run against the live database on 2026-09-07 and all ten checks passed, including the ones no
  client-side suite can reach because they need two signed-in users and the ability to age records:
  the volume floor (7 judgements at 100% contradicted does **not** silence anyone, so a small group
  of dissenters cannot mute a reporter who is right), the 70% boundary exactly, and the full
  lifecycle — clean allowed, in cooldown genuinely blocked by row-level security rather than only
  by the UI, aged out after 31 days allowed again. `pin_confirmations` stayed unreadable even to
  the person whose own judgement wrote the row. It rolls back: user, pin, vote and confirmation
  counts were identical before and after.
  What remains a guess is the thresholds themselves — 8 judgements, 70% contradicted, a 30-day
  window (`backend/005`). Those need real traffic. Wrongly silencing an honest reporter is much
  worse than letting a careless one continue, so err toward leniency when tuning.

### The outbox — **done, 2026-09-08**
Marks made without a signal were lost. Since the error-handling fix they were honestly refused, but
still lost, and that is the wrong answer for this app in particular: walk mode exists to be used
while walking, and walking is when a phone drops to no bars. The moment the feature is most useful
is the moment its writes are most likely to fail.

A write that fails for lack of connection is now kept on the device and sent when there is one.
Three rules keep it honest:

- **A queued mark stays visible and says so.** It is not pretended to be saved, and it does not
  vanish either — those were the original bug in its two opposite directions. My reports shows
  "⏳ Waiting to upload", and the My Page hub row counts them.
- **Only a connection failure is queued.** A mark the server actively refused — the reputation
  cooldown, a duplicate vote — would be refused identically in an hour, so retrying forever would
  be a queue that never drains. Those are dropped, and the walker is told.
- **"Clear my data on this device" does not touch it.** That button promises your ratings survive
  it, and a queued mark is a rating that has not been saved yet.

`refreshPinsFromCloud` replaces the whole pins array with what the server returned, which by
definition excludes anything queued, so `restorePendingPins()` runs after every one of the three
paths through it — fresh data, cached fallback, and total failure. Missing it from any one of them
reproduces the original complaint exactly.

Verified in the browser by driving the real client through the whole cycle: an offline mark is
queued and stays on the map labelled pending; it survives the pins array being replaced; it survives
a genuine page reload; on reconnect it uploads, gets its real id, loses the pending flag and leaves
the queue empty; and a server refusal is dropped rather than retried, with the count reported.

Still open here:
- Only pin creates and votes are queued. Edits and deletes of an already-saved mark still need a
  connection, and say so.
- The queue holds the walker's own unsent marks — coordinates and times, on their own device, until
  each one lands. Capped at 200 and never sent anywhere except as the marks themselves, but it is a
  local trace, which is worth remembering if the device itself is the threat.

### Somewhere to go (refuges) — **done, 2026-09-08**
Borrowed from the competition, and possibly the best idea in the category. Every other layer here
tells you what to avoid; this is the only one that tells you where to **go** — the nearest door you
can walk through, open now, with people behind it.

It needed no new data source and no partnerships. OpenStreetMap already knows, and the app already
talks to Overpass. Lives under "Near me", loaded after the sheet opens so a slow Overpass never
holds it shut.

**`isOpenNow()` is in geo.js with eight tests, and returns three values, not two.** `opening_hours`
is a small language — `Mo-Fr 08:00-20:00; Sa 10:00-16:00; Su off` is ordinary, and so is syntax this
deliberately refuses to read. It handles 24/7, day ranges and lists, ranges that wrap past Sunday,
several spans per day, spans crossing midnight, `off`, and later rules overriding earlier ones.
Everything else — public holidays, week numbers, `sunrise-sunset` — returns **null, meaning "cannot
tell"**, never a guess. That null is the whole point: this decides whether a frightened person walks
to a door, and a place wrongly shown as open costs them two minutes at the moment they least have
two minutes. Places known to be shut are dropped; unknown ones are kept and labelled, because a
hotel lobby whose hours nobody recorded is still worth knowing about at 1am.

**Ranking was wrong on the first run, and only real data showed it.** Sorting by kind first returned
five pharmacies for central Oslo — every one shut at 1am, four of them present only because their
hours are unrecorded. Confirmed-open now sorts ahead of kind, and no more than two of any one kind
appear. Re-run at 02:00 on a Saturday from Jernbanetorget it returns the 24-hour pharmacy, two
7-Elevens and two Jokers, all confirmed open. That is the feature working.

**Both Overpass mirrors are tried.** The main one rate-limits in earnest — measured here, three
refuge queries within a few minutes and it began refusing. This is the layer someone reaches for
when they already want to be somewhere else, so one throttled host must not end it. A failure says
"could not look up nearby places", never "nothing open" — the house rule.

Still open:
- Verified schemes run by councils exist in some countries and would beat OSM where they exist.
- Hotels are the interesting gap: a lobby is one of the better places to walk into and 24-hour
  reception is normal, but only 4 of 51 in central Oslo state hours, so most show as unconfirmed.
- Walking directions to a refuge were added the same day: "Walk me there" hands it to the ordinary
  route planner rather than a second one, so it gets the same hazard-aware ranking as any other
  walk. That matters more here than anywhere — being routed towards a police cordon while trying to
  get away from something would be the worst bug this feature could have.

### Incident reports — **done, 2026-09-08** (migration 019)
Different in kind from a rating, and the schema knows it. A rating is an opinion about a place; an
incident report asserts that **a crime happened** at a time and place, published to strangers. The
two documented failure modes of this exact product category are designed against in the database,
not in the UI where they could be edited away.

**It must not become a way to report people.** Every category names an EVENT — assault, robbery,
harassment, fighting, unsafe place. There is no "suspicious" and no "scary", because those invite a
description of somebody who was standing there, and everywhere they have shipped the reports skew
hard against minorities and homeless people. No photo column, no field for describing a person, note
capped at 140 characters, and the form says plainly that reports naming or describing people will be
removed.

**It must not become a permanent accusation.** Seven-day life, then purged hourly by cron — not
merely filtered out, since a hidden row is still an accusation sitting in a table.

**Disputes, weighted by who was there.** Confirm or dispute from the report's own sheet; a vote from
within 250m counts double. A weight, never a gate (ROADMAP option 3): the client can lie either way,
so gating blocks honest people with bad GPS and stops nobody, and — the point — it stores no new
fact about where anyone was, because the vote already names a place. A report is hidden once
weighted doubt reaches 3 **and** exceeds its support; the floor of 3 is the reputation system's
volume-floor lesson, without which two people could erase a true warning.

**Timestamps are hour resolution, not day.** Rule 2 forbids day-finer times for *pins* because pins
made minutes apart along a route reconstruct a walk. That reasoning does not transfer: a pin is one
of many along a path, an incident is a single exceptional event, and its recency is most of its
value — "an hour ago" and "six days ago" are different warnings. Hour keeps that without pinning
anyone to a minute.

**Drawn as a red diamond with a warning glyph, never the police layer's dashed area**, with its own
row in the map key, and the report sheet says "Reported by someone using SafeWalk — not by the
police". If a stranger's claim can be mistaken for an official one, the app has laundered it.

Verified against the real database, rolled back: a fresh report is public; two distant doubters do
NOT remove it (below the floor); a third does; two people who were actually there bring it back
(weighted 4 against 3); an expired one vanishes. With the anon role, the raw `incidents` table and
`incident_votes` are both refused while the public view is readable. Verified in the browser with
the public key and no account: the layer loads, the public shape carries no `user_id`, the time is
hour-resolution, and the proximity hint flips correctly between near and far.

Still open:
- No moderation path beyond community disputes. A defamatory report can be voted down but not
  reported to anyone, and there is no appeal for a walker whose report is wrongly buried.
- Reporter standing now counts incidents too (migration 020). A disputed report is a judgement of
  its author, exactly as a contradicted pin is, and the same thresholds apply: 8 judgements, 70%
  contradicted, 30 days. Being repeatedly wrong about incidents also pauses your pins, and the
  reverse — both are claims about whether somewhere is safe.
  The decision worth remembering: incident_confirmations has NO foreign key to incidents. Reports
  are deleted after seven days, and a cascade would wipe a serial false reporter clean every week —
  precisely the person the record exists to slow. The judgement outlives the report and is purged
  on its own after 90 days. Verified: nine disputed reports produce nine judgements, all nine
  survive deleting every report, and the author is then blocked from adding pins AND incidents.
- Two categories were removed after the owner reviewed them (021, 022). "Fighting or aggression"
  was redundant with assault and unsafe-place, and worse, was the closest thing to "scary" that
  survived 019 own filter: "an aggressive group" is people-shaped and invites exactly the report
  this app must not collect. And the free-text note is gone entirely — it was the one field that
  could carry a description of a person, and no constraint can stop that. Keeping it unpublished
  for future moderation was considered and rejected: collecting personal data about third parties
  for a purpose that does not exist yet is what data minimisation forbids, and a moderator needs
  the category, place, time and disputes, all of which are recorded. Context about a PLACE belongs
  on a rating, which still has notes.
- Warning someone walking towards a report was added the same day: within 150m, only reports from
  the last 24 hours, never your own, and once per report per session. A six-day-old incident is map
  context rather than something worth a buzz. The banner is shared with the police alert but takes
  an amber edge instead of solid red and always begins "Someone using SafeWalk reported" 2014 a
  community claim must never borrow the police layer's authority. Kept dark rather than flipped to
  a bright fill, because this appears on a phone at night where a light banner is both blinding and
  conspicuous. Verified: fires when fresh and near, stays quiet for a four-day-old report 20m away,
  stays quiet far from a fresh one, and does not repeat.

## Accessibility

Audited and fixed: focus now enters a sheet when it opens, sheets trap focus while open, motion is
honoured via `prefers-reduced-motion`. Touch targets meet 44px — but that claim stood here while
six controls did not, and was only true after an audit on 2026-09-08 measured every button in the
app rather than assuming. All four themes pass WCAG AA
contrast for body text, dim text and the three rating colours used as text.

The accessibility tree was walked on 2026-09-07 — that is the structure a screen reader actually
consumes, though not the same as hearing it. What it showed:

- **"Near me" works as the non-visual equivalent of the map**, which was the gap flagged here.
  It reads as "40 m west — Testgata", then "mostly reported unsafe · 0 safe, 4 unsafe", then the
  note. Distance, direction, verdict and reason, in that order, with no map needed. It is much
  more trustworthy since the bearing fix — it used to name the wrong direction outright.
- All 11 sheets are `display:none` when closed, so no closed dialog leaks into the tree.
- Every form control resolves to a real name; the theme picker exposes `aria-pressed` with
  exactly one chip pressed, so the current theme is announced rather than only shown.

Still genuinely untested: no actual screen reader has been run. The tree being well-formed does
not prove the experience is coherent read aloud — ordering, verbosity and whether the map's own
silence is confusing can only be judged by listening.

The OpenStreetMap attribution link stays below 44px on purpose; it is a required credit rather than
a control, and enlarging it would put a tap target over the map.

## Known weak points worth attacking

- **Lit streets now work — and had never worked before 2026-09-07.** This entry used to say the
  layer could not be verified here but "should work on a real phone". That was wrong. NVDB rejects
  any request whose User-Agent it dislikes (400, code 4017), and a browser cannot set User-Agent —
  it is a forbidden header, so fetch() ignores it and the browser's own string is refused too.
  Confirmed from a real Chrome against the live site. The layer was therefore impossible from the
  client on every device since it shipped, while the map key claimed it existed.
  It now goes through the `lit-streets` edge function, which can set the header. Verified: 17
  segments in central Oslo, 36 in Tromsø, 34 polylines drawn in the app.
  Worth knowing about NVDB: its message asks for "a User-Agent that identifies the system", but
  the check really wants a browser-shaped string. `SafeWalk/1.0 (...)` is refused;
  `Mozilla/5.0 (compatible; SafeWalk/1.0; +url)` is accepted.
- **`spatial_ref_sys` is writable with the public key** and cannot be fixed from a migration — see
  `backend/KNOWN_ISSUES.md`. Needs Supabase support or moving PostGIS out of the public schema.

- **Third-party APIs have no SLA**, but the failure paths were audited on 2026-09-07 by stubbing
  each service individually (so the rest of the app stayed real) and they hold up better than this
  entry used to claim. Every one gives up in about a second, re-enables its button and leaves no
  half-rendered state:
  - Valhalla down — "The routing service is taking too long to respond. Try again in a moment."
  - Overpass down — falls back to spot mode and says the street map service is not responding,
    deliberately not blaming the location.
  - Nominatim down — this one was wrong and is now fixed: a dead geocoder produced "Couldn't find
    that address, try adding a city name", which sends someone off correcting a correct address.
  - NVDB down — silent until 2026-09-06; now warns once and stays retryable.

  Still worth doing: the Valhalla message says "taking too long" even when the connection failed
  instantly. The advice it gives is right either way, so this is cosmetic.
- **Service worker registration cannot be exercised in this development environment**, so offline
  has never actually been watched working. Registration fails here with "An unknown error occurred
  when fetching the script" — but an A/B against a second, unrelated server serving a three-line
  worker fails identically, so it is the browser pane, not our code or `server.ps1`. (A `no-store`
  cache header on the worker script was the obvious suspect and is a real hazard elsewhere; it was
  not the cause here, and the speculative fix was reverted.) The consequence is that the whole
  offline path — install, precache, the fall back to cache when the network drops — rests on
  reading the code. **Worth testing on a real phone in airplane mode before the feature is sold.**
- **Offline: written, not yet witnessed.** The last successfully loaded ratings are cached and shown
  with an age banner, the street network cache persists for a week, and as of 2026-09-07 map tiles
  are cached too — previously an offline user saw marks floating on a blank grey page, which looks
  broken and gives no sense of where anything is. Only tiles already fetched for a view someone
  looked at are kept, nothing is prefetched, and the cache is capped at 400 tiles (~5-12MB), which
  is what the OSM tile usage policy asks for.
  Verified what could be here: the file parses, the tile matcher accepts the three OSM subdomains
  and rejects `eviltile.openstreetmap.org`, `tile.openstreetmap.org.attacker.com` and our own
  origin, tiles are handled before the same-origin gate, activate keeps both caches (deleting
  everything but the shell would have thrown away the map on every version bump), and the trim was
  run against the real Cache API — 430 entries in, 400 out, oldest evicted, newest kept.
  **Not verified: any of it actually running.** Service worker registration is blocked in this
  development browser, proven by an A/B against an unrelated server. Airplane mode on a phone,
  now that the app is on HTTPS, is the only thing that settles it.
- **Test coverage is thin.** `tests/geo.test.js` now covers the pure maths in `safewalk-app/geo.js`
  (82 assertions: distances, street graph, shortest paths, polyline decoding, rating bands, route scoring, and where a mark made while walking lands). Run it
  with `node tests/geo.test.js`. Nothing else is covered — the persistence layer, the auth gates, the
  reputation flow and all DOM behaviour are still hand-verified only. Route scoring in particular
  deserves tests; it lives in `app.js` and reads the global `pins`, so it needs a small refactor to
  take its inputs as arguments before it can be tested.
- **Route scoring is O(samples x pins).** Measured: 4.6ms at 200 pins, 12.9ms at 2000, 30.8ms at
  5000 — and that is per route, so roughly triple it. Fine now, and the geographic fetch bound
  keeps the pin count local, but a spatial index on the client would be the fix if it ever bites.
- **`renderPins` is NOT a bottleneck**, contrary to an earlier note here. Measured: 1.6ms at 50
  pins, 8.7ms at 1000, 14.3ms at 2000 — under one frame, scaling linearly. Left alone deliberately.

## Ideas from the owner — proposed 2026-09-08, none started

Written down after the owner looked at the competition. Kept together because three of them
interact, and two of them are decisions about what SafeWalk *is* rather than features to schedule.

### What the competition actually does — safetymap.io, read 2026-09-08
Worth recording, because it changes the shape of two ideas below. Safetymap (by Wicupp) is a
**native iOS/Android app**, 15k downloads, 30+ countries, 4.2★, free, no account needed to read the
map. Community area ratings, incident alerts (theft / harassment / aggression), safe-route guidance
— all of which SafeWalk has or is planning. Two things it has that we have not thought about:

- **A refuge network**: the nearest *open* place you can walk into right now — a pharmacy, a shop.
  Arguably more useful in the moment than any amount of colour on a map, because it is the only
  feature in the category that tells a frightened person where to *go* rather than what to avoid.
- **A business model**: "Safetymap Pro" sells private moderated alert channels to shopping centres,
  campuses, industrial sites and local authorities. Free for citizens, paid for by organisations.
  If "sellable" is the goal, that is where the money in this category demonstrably is — not in
  charging the person walking home.

The strategic read: the idea is not novel and is already executed globally at modest scale. What
SafeWalk has that a global app structurally cannot is **local depth** — the Politiloggen
integration is official Norwegian police data, per-district, and nobody operating in 30 countries
will build that for Norway. Depth in one country is the defensible position, not breadth.

### 1. Green/red fog instead of hard circles
Not only prettier — more honest. A crisp circle claims a boundary the data does not have: "safe up
to this line, unsafe past it" is false, and drawing it that way states a precision we cannot
support. A soft field is a truthful rendering of uncertainty.

**The constraint that must not be lost:** rule 1 of this file. Rating colours carry a redundant
line style (solid / dashed / dotted) so the map survives colourblindness, and a fog has no line
style to carry. Any implementation needs a second channel — texture, hatching, or keeping crisp
dashed outlines for street pins and using fog only for area pins. A fog that encodes safety in hue
alone is a regression however good it looks.

### 2. Rating unlocks features — e.g. incident notifications
**Recommend against this specific form, and the reason is not squeamishness.** Gating *nearby
incident alerts* behind contribution means the person who has not rated anything does not get told
that something happened on the street they are walking down. That is withholding a safety warning
from someone to make them participate, and it is the one currency this app must never trade in.

It also fights the reputation system already built (migration 005), which exists to reward accuracy
and can silence a reporter who is repeatedly contradicted. An incentive that rewards *volume* pulls
directly against it.

Incentives that do not have this problem: showing someone how many walkers passed the places they
marked; earned standing that visibly weights their reports; unlocking non-safety extras (themes,
personal stats, history export). Reward contribution with recognition, never with safety.

### 3. An incident button — "something bad happened here"
The strongest idea of the five, and the most dangerous to build carelessly. It is different in kind
from a rating: a rating is an opinion about a place, an incident report is an **accusation that a
crime occurred at a time and place**, published to strangers.

Two failure modes are well documented in this exact product category (Citizen, Nextdoor, Ring
Neighbors) and must be designed against from the first version, not retrofitted:

- **It becomes a way to report people rather than places.** A "scary" category invites exactly
  that, and in every app that has shipped it the reports skew hard against minorities and homeless
  people. Mitigations that work: categories that name *what happened* (assault, theft, harassment,
  followed) and never *who was there*; no photos of people; no free-text description of a person;
  and a note in the UI saying the report is about a place.
- **It becomes defamation.** "Violence here, 23:40" at a precise address can identify a real
  incident and a real person. Needs the existing cooldown/reputation gate applied at least as
  strictly as pins, an expiry (incidents are news, not permanent facts about a street), and a
  visible way to contest one.

Also: the police layer already draws official incidents. Community incidents must look
*different* from Politiloggen ones on the map, or the app launders a stranger's claim into
something that reads as a police report.

### 4. Legal standing and IP
Not legal advice — this is orientation for a conversation with a lawyer, not a substitute for one.

**On protecting the idea:** ideas are not protectable; implementations are. Copyright already
exists automatically in the code. Patents are unlikely to be worth it here — expensive, slow, and
the prior art is thick (Safetymap alone predates us). "Making sure no one can steal the idea" is
the wrong goal because the idea is already public and already built by others; what is defensible
is execution, brand, and the accumulated local data.

**The name is worth checking first.** "SafeWalk" is close to generic and is already the common name
for university walking-escort services in several countries. A trademark search before any money
goes into branding is cheap and may save renaming later.

**The bigger legal exposure is not IP — it is data protection.** This app records where identified
users walk, in the EEA. Under GDPR that is personal data, and a route home is about as sensitive as
location data gets. What that means in practice: a real privacy policy, a stated lawful basis,
working data subject rights (access, deletion), a data processing agreement with Supabase, a
retention policy, and a defensible answer to "what happens if this database leaks". Norway's
Datatilsynet publishes guidance in plain Norwegian. Publishing user-generated crime accusations
(idea 3) adds defamation exposure on top.

Order of priority, if there is only budget for one conversation: data protection first, trademark
second, patents not at all.

### 5. Journey tracking, timers, and telling a contact you got home
Standard in this category and genuinely useful. Two hard truths before designing it:

- **A web app cannot do this reliably on iOS.** Background geolocation stops when a PWA is
  backgrounded or the screen locks, so "raise the alarm if they stop moving for ten minutes" cannot
  be built on what SafeWalk is today. Web Push works on iOS 16.4+ but only for a PWA installed to
  the home screen. This idea, more than any other on the list, is what would force a native app —
  and that is a much larger decision than a feature.
- **Requiring the contact to install the app and make an account will kill it.** The person you
  most want to notify is a parent who will not do that. A tokenised link, sent however the user
  likes, that opens a plain web page showing "walking, last seen 21:40, expected home 22:10", costs
  the recipient nothing. SMS would be better still but needs a paid provider.

False alarms are the whole design problem: stopping to talk to someone must not call anyone. Any
alarm needs a generous countdown the walker can cancel, and the cancel must be reachable in one
tap without unlocking anything.

### The decision hiding in this list
Ideas 2 and 5, and incident *notifications* in idea 3, all want push notifications and background
location. Both are things a web app does badly or not at all on iOS. Safetymap is native for
exactly this reason. So the real question underneath these five ideas is whether SafeWalk stays a
web app — instantly openable, no install, no app store — or becomes native and gains the ability to
warn people when it is not open. That is worth deciding deliberately before building any of them.

### Owner's decisions on the above — 2026-09-08, evening

#### Branding is provisional and will change before launch
Name, logo, colour themes and general style are all placeholders as far as launch is concerned. The
owner expects to redo most of them. Two consequences worth acting on now rather than later:

- **Do not spend effort polishing the current look**, and do not let the maintenance agent pick
  "visual design" items. The four themes exist to prove the token system works, not because these
  are the final colours.
- **Keep the token system strict.** Because every colour already comes from a CSS custom property,
  a rebrand is a new set of token values rather than a rewrite. Any hardcoded hex added between now
  and then is a future rebrand that costs a day instead of an hour. Rule 1 still binds: whatever
  the new palette is, rating colours keep their solid/dashed/dotted redundancy.
- A trademark search belongs *before* the naming work, not after — see the IP note above.

#### Rewards yes, paywall yes, but never over safety information
Agreed: nothing that warns someone goes behind a reward or a payment. Alerts, the police layer,
route safety and SOS stay free and ungated for everyone, signed in or not.

What can be rewarded or sold without touching that: personal history and stats, more than one
emergency contact, data export, offline map packs for a whole city (a genuine storage cost),
recognition for accurate reporting, and the organisation accounts the competition already sells.

**The real cost cliff is not Supabase.** SafeWalk currently runs on four free public services —
Overpass, Valhalla, Nominatim and NVDB — each with a usage policy that assumes modest traffic.
Nominatim's is explicit about no systematic querying, and we already respect it. At any real scale
those either break, get blocked, or have to be self-hosted or replaced with paid providers, and
that is the bill a paywall would actually be paying. Worth pricing before promising anything.

#### Incidents: generic categories, and votes only from people who were there
Agreed direction, with the safeguards above. The owner adds an upvote/downvote so false incidents
can be removed, restricted to people who have actually walked past that point recently.

**That restriction has a real tension with the privacy work and needs deciding, not assuming.**
Verifying that someone was there means having a record that they were there — and migration 017
exists precisely so the database does not hold a usable trail of where individuals walked. The
client can *claim* a location, but a claim is not proof: anyone can post any coordinate, so a
purely client-side check deters casual abuse and nothing more.

Three honest options, in rough order of preference:
1. **Accept the weak check** — client asserts proximity, server enforces only rate limits and the
   existing reputation/cooldown gate. Cheap, keeps the privacy position, stops lazy abuse only.
2. **Short-lived presence tokens** — the app records that this user was near this cell, kept for
   hours not months, never published. Stronger, but it reintroduces exactly the record 017 removed,
   with a retention promise as the only protection.
3. **Weight rather than gate** — anyone may vote; votes from a device that was recently nearby
   count for more. Degrades gracefully and leaks less than (2).

Whichever is chosen, incidents need an expiry — they are news, not permanent facts about a street.

#### Two walking modes: normal, and a watched walk
Normal walk mode is what shipped today. The second mode keeps the app open and linked to another
user in real time, accepting that the screen stays on.

**This is buildable on the web as it stands, which the background-alarm version is not.** The
Screen Wake Lock API keeps the display awake, and geolocation keeps running while it is — so a
"stop moving for ten minutes and your watcher is told" alarm works *in this mode specifically*.
Supabase Realtime can carry the live link without new infrastructure. What it costs is battery, and
that has to be said plainly on the way in rather than discovered at 30% charge.

The two modes must look and feel clearly different, or someone will believe they are being watched
when they are not — which is worse than not offering it.

#### Emergency contact stays a phone number, with an optional linked user
A phone number is the primary contact and stays that way: it works when the other person has no
account, no app, and no data. Optionally, and additionally, a contact may be another SafeWalk user,
which is what the watched-walk mode links to. Never a replacement — the fallback must always be a
call.

#### Refuges: OpenStreetMap, and the coverage is better than expected
Measured on 2026-09-08 with a live Overpass query over central Oslo (59.905–59.935, 10.70–10.78),
counting places someone could plausibly walk into: **1282 candidates, 773 with `opening_hours`
(60%), 27 tagged `24/7`.** Coverage is best exactly where it matters:

| Kind | Total | With opening hours |
|---|---|---|
| Supermarket | 150 | 147 (98%) |
| Pharmacy | 50 | 46 (92%) |
| Convenience | 44 | 29 (66%) |
| Restaurant | 564 | 309 (55%) |
| Fuel | 8 | 4 (50%) |
| Hotel | 51 | 4 (8%) |

So this needs no new data source and no partnerships to start: the app already queries Overpass for
street geometry, and this is the same pipe. Three cautions:

- **`opening_hours` is a small language**, not a time range — `Mo-Fr 08:00-20:00; Sa 10:00-18:00;
  PH off` is ordinary. Handling `24/7` and simple weekday ranges covers most of the value;
  `opening_hours.js` handles the rest if a dependency is ever justified.
- **A closed refuge is worse than no refuge.** Someone frightened walks to a locked door and has
  lost two minutes. Only show places we are confident are open now; where the hours are unknown,
  either omit them or label them plainly as unconfirmed.
- **Hotels are the interesting gap**: 24-hour reception is a norm and a hotel lobby is one of the
  better places to walk into, but only 8% state hours. Worth treating as a separate, clearly
  labelled category rather than dropping.

Verified schemes run by councils exist in some countries and would be stronger than OSM where they
exist; that is a later step, not a blocker.

#### Long term: ship it through the app stores
The owner wants SafeWalk installable from Google Play and the App Store. Recorded as direction, not
scheduled work.

The pragmatic route is a **Capacitor wrapper**: the existing web app keeps being the app, gains a
native shell, and with it background geolocation, real push notifications and a store listing —
which is what unlocks the alarm-while-closed version of the walked-home feature. A full native
rewrite buys little that a wrapper does not, at many times the cost.

Two things to know before committing: both stores review apps that handle location and emergencies
more carefully than average, and an app that tells people where is safe invites questions about
accuracy and liability. And once there is a store listing, the privacy policy and data-protection
work stops being optional — Apple and Google both require a privacy label before the first release.

### Watched walk — designed 2026-09-08, not yet built
The owner's design, with the constraints that actually bind.

**Settled and buildable as a web app:**
- The watcher's phone sleeping is a normal state, not a failure. The walk's current state lives in
  the database, not only in realtime events, so opening the app at any point shows where the walker
  is now rather than replaying what was missed. Realtime is the fast path; the row is the truth.
- Both phones hold a Screen Wake Lock for the duration, re-acquired on `visibilitychange` because
  the browser releases it whenever the page is hidden. Neither side sleeps until the walk is ended
  deliberately.
- The walk ends one of three ways: the walker arrives, the walker cancels, or the alarm fires.

**The constraint that decides the escalation design: a web page cannot place a phone call.**
`tel:` requires a user gesture — a page cannot dial on its own on iOS or Android, and even a native
app cannot place a call silently. So "if the push doesn't reach the watcher, call the emergency
contact" cannot happen automatically in what SafeWalk is today. Something has to be able to act
while nobody is looking at a screen, and only a server can do that.

Three honest options:
1. **Server-side SMS** (Twilio or similar). The only one that genuinely reaches a person who is
   not holding their phone: "Michael started a walk home at 23:10 and hasn't arrived. Last seen
   Storgata." Works whether or not the watcher has the app, which is the same reason the emergency
   contact stays a phone number. Costs real money per message — and it is precisely the kind of
   thing the premium plan exists to fund.
2. **Alarm on the walker's phone**, full screen, loud, with a one-tap "Call <name>" button. Free and
   immediate, but it only helps if the walker can still reach their phone — which is exactly the
   case the alarm exists for.
3. **Both**, with (2) firing first and (1) after a further delay.

Recommended: build (2) now because it costs nothing and is honest, and treat (1) as the first
premium feature with a real marginal cost behind it. Until (1) exists, the app must not imply
anybody will be called automatically.

**False alarms are the whole design problem.** Stopping to talk to someone must not summon anyone.
Any alarm needs a generous countdown, cancellable in one tap without unlocking anything, and the
walker must have been told what the trigger is before they set out. An alarm system people learn to
distrust is worse than none.

**Built 2026-09-08.** Migration 018 and the client are live. What shipped:

- **The walker** taps "👁 Walk with someone watching" on a route, gets a link, and sends it with the
  phone's own share sheet. While walking, a strip above the walk buttons says so — the two modes are
  unmistakable, because believing you are watched when you are not is worse than not offering it.
- **The watcher** opens that link. No account, nothing installed, no bottom bar: the page shows a
  status dot, where the walker is, and how old that is. It re-asks every ten seconds and holds a
  wake lock, so a phone left face-up keeps updating.
- **Wake lock is retaken on `visibilitychange`.** The browser drops it whenever a page is hidden, so
  without that one glance at another app ends the walk silently.
- **The alarm** fires after ten minutes without movement: a sixty-second countdown, cancellable with
  one tap on the status line — the place the thumb already goes — and moving again cancels it by
  itself. Nothing is sent until the countdown runs out.

Privacy, decided in the schema rather than bolted on:
- **Only the latest position is stored, overwritten.** No breadcrumb table, deliberately: a watcher
  needs where you are, not where you have been. Same argument as 017, applied before the data
  existed rather than after.
- **The row expires after twelve hours and is purged hourly by cron.** Filtering an expired row out
  of a query is not a retention policy; deleting it is.
- **The watcher never touches the table.** anon and authenticated have no select on `walks` at all.
  A watcher holds a token and calls one `security definer` function returning the walk's public
  face — never `walker_id`, never another walk. Verified with the public key: every column of the
  table is refused, an insert is refused, the purge function is refused, and a guessed token returns
  an empty result indistinguishable from an expired one.
- **The walker's phone number is never in the row**, which is why the watcher's page has no call
  button. It tells them to call rather than pretending it can.

Verified against the real database, not stubs: a genuine walk row was created, watched through the
shared link, and driven through every status — walking (live dot, position on the map, "last seen 2
minutes ago"), alarm ("They have stopped"), arrived ("They got there", polling stops) — plus an
unknown token reading as "Nothing to follow". The walker side was driven through share, start, the
alarm countdown, a one-tap cancel that sends nothing, and finish sending `arrived`.

**Not verified: two phones, moving, at night.** Every position was set by hand, the wake lock has
never been watched holding a real screen awake, and the ten-minute idle threshold is a guess that
only a real walk will confirm or refute.

Still open:
- No push. A watcher whose phone is asleep learns nothing until they open the page — which is why
  wait-mode reads current state rather than replaying events, but it is not a substitute.
- No SMS, so nothing reaches anybody who is not looking at a screen. First premium feature.

### Proximity-gated voting — decided 2026-09-08: option 3
The owner deferred the choice. Taking **option 3, weight rather than gate**, and the reason is
sharper than "it leaks least".

A vote already carries a location: `pin_id` *is* a place. Attaching "I was near this when I voted"
therefore adds no new fact about where somebody was — it says something about a place they had
already told us they were interacting with. Option 2 is different in kind: a presence record exists
whether or not the person ever votes, which is a trail of where they walked, and that is precisely
what migration 017 was written to destroy. Rebuilding it with a retention promise as the only
protection would undo today's work for a benefit that cannot be enforced anyway.

Because the client can lie about proximity either way, a gate is security theatre — it stops nobody
determined and blocks honest people with bad GPS. A weight degrades gracefully: a false claim buys a
little influence rather than the right to erase a warning, and the reputation system already in
place is what actually handles bad actors.

### Premium — agreed 2026-09-08
Nothing that warns anybody is ever behind it. Agreed list:
- **Offline city packs** — the whole of a city's tiles and street network, downloaded for a trip.
  A genuine storage and bandwidth cost, so charging for it is defensible rather than artificial.
- **More than one emergency contact**, and watched walks with more than one watcher.
- **Your own history and statistics.**
- **Custom themes and icon packs** — the one category where paying changes nothing for anyone else.
- **Server-side SMS alerts** (see above), once they exist.
Organisation accounts remain the larger opportunity: campuses and councils paying for a private
channel while citizens use it free.

### Naming — still open
None of Lykta, Følge, Nattevakt, Trygg vei or Hjemveien landed. Deferred. The constraints stand: the
current name is close to generic and already in use by university escort services, a trademark
search belongs before any logo work, and the token system must stay strict so a rebrand costs an
afternoon.

## Rules that must not be broken

1. **Never publish authorship.** `pins_with_scores` exposes `is_mine`, never `user_id`; `votes` and
   `pin_confirmations` are not readable by other users. Grouping pins by author reconstructs where an
   individual walks and when.
2. **Never publish other people's pin timestamps at better than day resolution** (migration 017 —
   `date_trunc('day', ...)` in the view, and `created_at` revoked from the table grant). Removing
   `user_id` closed the grouping key but not the trail: pins made seconds apart along a contiguous
   path are one person walking, and order plus geometry draws the path. Walk mode produces exactly
   that shape by design. Anything that wants to show "20 minutes ago" on a fresh warning is
   reopening this trade and must do so deliberately. The same lesson as 012 applies — fixing only
   the view leaves the column readable straight off the table.
3. **Bump `safewalk-app/version.json`** on any client change, or open apps keep running the old build.
4. **Migrations are append-only.** Never edit an applied file in `backend/`; add the next number.
5. **Only the anon key belongs in the repo.** Never the `service_role` key or the database password.
6. **Walking and biking only.** Never car routing — the app is for people on foot.
