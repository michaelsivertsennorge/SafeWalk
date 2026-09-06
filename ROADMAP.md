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
- A custom/user-defined theme (pick your own accent) is not implemented; only the four presets.
- Rating colours must keep their dash patterns (solid / dashed / dotted). That redundant encoding is
  what makes the map readable for colourblind users, and no palette change may drop it.

### Still open
- **Politiloggen integration.** Police incident data (politiet.no, NLOD 2.0) marking places red
  temporarily. Verified: the API exists, has `isActive`/`createdOn`, and filters by municipality —
  but returns **no coordinates** (only municipality + area) and blocks CORS, so it needs a
  server-side sync job. Geocoding the `area` field is unreliable: "Fuglevik, Råde" resolved to
  Kristiansand, 230 km away. Any implementation must validate the result against the stated
  municipality and discard mismatches rather than guessing.
- **Google sign-in** alongside email/password. Needs Google Cloud console setup.
- **Reputation tuning.** The cooldown thresholds in `backend/005` (8 judgements, 70% contradicted,
  30-day rolling window) are a first guess with no real data behind them. Revisit once there is
  traffic. Wrongly silencing an honest reporter is much worse than letting a careless one continue.

## Known weak points worth attacking

- **Third-party APIs have no SLA.** Overpass, Valhalla, Nominatim and NVDB can all be slow or down.
  Failure paths exist but are thin; a slow Overpass currently just makes the street picker feel
  broken.
- **Offline.** The service worker caches the shell, but the app has nothing useful to show without
  the network, and the map is the whole product.
- **Test coverage is thin.** `tests/geo.test.js` now covers the pure maths in `safewalk-app/geo.js`
  (22 assertions: distances, street graph, shortest paths, polyline decoding, rating bands). Run it
  with `node tests/geo.test.js`. Nothing else is covered — the persistence layer, the auth gates, the
  reputation flow and all DOM behaviour are still hand-verified only. Route scoring in particular
  deserves tests; it lives in `app.js` and reads the global `pins`, so it needs a small refactor to
  take its inputs as arguments before it can be tested.
- **`renderPins` redraws every pin on every change.** Fine at today's scale, not at a city's.

## Rules that must not be broken

1. **Never publish authorship.** `pins_with_scores` exposes `is_mine`, never `user_id`; `votes` and
   `pin_confirmations` are not readable by other users. Grouping pins by author reconstructs where an
   individual walks and when.
2. **Bump `safewalk-app/version.json`** on any client change, or open apps keep running the old build.
3. **Migrations are append-only.** Never edit an applied file in `backend/`; add the next number.
4. **Only the anon key belongs in the repo.** Never the `service_role` key or the database password.
5. **Walking and biking only.** Never car routing — the app is for people on foot.
