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
- Buttons are still fairly plain. "Prettier buttons" was part of the ask and has not really been
  addressed — only the palette has.
- No per-theme testing on a real phone outdoors yet.
- Rating colours must keep their dash patterns (solid / dashed / dotted). That redundant encoding is
  what makes the map readable for colourblind users, and no palette change may drop it.

### Still open
- **Politiloggen — shipped, first pass.** Police incidents now sync hourly via the
  `politiloggen-sync` edge function and show on the map as dashed red areas. See
  `backend/functions/politiloggen-sync/README.md` for what it decides and why.
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
- **Reputation tuning.** The cooldown thresholds in `backend/005` (8 judgements, 70% contradicted,
  30-day rolling window) are a first guess with no real data behind them. Revisit once there is
  traffic. Wrongly silencing an honest reporter is much worse than letting a careless one continue.

## Accessibility

Audited and fixed: focus now enters a sheet when it opens, sheets trap focus while open, motion is
honoured via `prefers-reduced-motion`, and touch targets meet 44px. All four themes pass WCAG AA
contrast for body text, dim text and the three rating colours used as text.

Still untested: no screen reader has actually been driven through the app. Everything above was
verified by measurement in a browser, which catches structure but not whether the experience makes
sense read aloud 2014 the map in particular has no non-visual equivalent, and 201cwhich streets near me
are marked unsafe201d is currently answerable only by looking.

The OpenStreetMap attribution link stays below 44px on purpose; it is a required credit rather than
a control, and enlarging it would put a tap target over the map.

## Known weak points worth attacking

- **The lit-streets layer cannot be verified from this development environment.** NVDB rejects any
  request whose User-Agent does not look like a browser, answering 400 with "User-Agent er ingen
  gyldig nettleser" (code 4017). Confirmed working with a normal browser UA: 200, 50 lit segments
  for central Oslo. It should therefore work on a real phone, but that has not been checked — the
  layer has only ever been observed empty here. Worth confirming on a device before selling the
  feature.
- **`spatial_ref_sys` is writable with the public key** and cannot be fixed from a migration — see
  `backend/KNOWN_ISSUES.md`. Needs Supabase support or moving PostGIS out of the public schema.

- **Third-party APIs have no SLA.** Overpass, Valhalla, Nominatim and NVDB can all be slow or down.
  Failure paths exist but are thin; a slow Overpass currently just makes the street picker feel
  broken.
- **Service worker registration cannot be exercised in this development environment**, so offline
  has never actually been watched working. Registration fails here with "An unknown error occurred
  when fetching the script" — but an A/B against a second, unrelated server serving a three-line
  worker fails identically, so it is the browser pane, not our code or `server.ps1`. (A `no-store`
  cache header on the worker script was the obvious suspect and is a real hazard elsewhere; it was
  not the cause here, and the speculative fix was reverted.) The consequence is that the whole
  offline path — install, precache, the fall back to cache when the network drops — rests on
  reading the code. **Worth testing on a real phone in airplane mode before the feature is sold.**
- **Offline is partly handled.** The last successfully loaded ratings are cached on the device and
  shown with an age banner when the network is gone, and the street network cache persists for a
  week. Still missing: map tiles are not cached, so an offline user sees marks floating on a blank
  background. Any tile caching must respect the OSM tile usage policy — cache what has already been
  viewed, never bulk-prefetch.
- **Test coverage is thin.** `tests/geo.test.js` now covers the pure maths in `safewalk-app/geo.js`
  (22 assertions: distances, street graph, shortest paths, polyline decoding, rating bands). Run it
  with `node tests/geo.test.js`. Nothing else is covered — the persistence layer, the auth gates, the
  reputation flow and all DOM behaviour are still hand-verified only. Route scoring in particular
  deserves tests; it lives in `app.js` and reads the global `pins`, so it needs a small refactor to
  take its inputs as arguments before it can be tested.
- **Route scoring is O(samples x pins).** Measured: 4.6ms at 200 pins, 12.9ms at 2000, 30.8ms at
  5000 — and that is per route, so roughly triple it. Fine now, and the geographic fetch bound
  keeps the pin count local, but a spatial index on the client would be the fix if it ever bites.
- **`renderPins` is NOT a bottleneck**, contrary to an earlier note here. Measured: 1.6ms at 50
  pins, 8.7ms at 1000, 14.3ms at 2000 — under one frame, scaling linearly. Left alone deliberately.

## Rules that must not be broken

1. **Never publish authorship.** `pins_with_scores` exposes `is_mine`, never `user_id`; `votes` and
   `pin_confirmations` are not readable by other users. Grouping pins by author reconstructs where an
   individual walks and when.
2. **Bump `safewalk-app/version.json`** on any client change, or open apps keep running the old build.
3. **Migrations are append-only.** Never edit an applied file in `backend/`; add the next number.
4. **Only the anon key belongs in the repo.** Never the `service_role` key or the database password.
5. **Walking and biking only.** Never car routing — the app is for people on foot.
