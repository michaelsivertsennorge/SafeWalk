# SafeWalk roadmap

What's wanted next, roughly in priority order. The hourly maintenance agent should pick **one**
item, do it properly, and open a PR — not sweep through several.

## Asked for by the owner

### Visual design: pastel palette and themes
The current look is dark and utilitarian. Wanted: a cleaner interface, more colour, prettier
buttons, pastel tones, and eventually a theme picker so people can choose their own.

Worth doing carefully rather than quickly:
- The rating colours (red / amber / green) carry meaning and are already paired with dash patterns
  for colourblind users. A pastel palette must keep both the contrast and that redundant encoding —
  a prettier map that is harder to read at a glance is a downgrade, not an upgrade.
- Contrast has to survive on a phone screen outdoors at night, which is the actual usage context.
  Aim for WCAG AA on text; do not let pastels drop body text below it.
- Themes should be CSS custom properties swapped at `:root`, stored per-device in `localStorage`
  alongside the existing dark-map preference. No rebuild, no per-theme stylesheet.
- The map tiles are recoloured with a CSS filter, so any theme has to be checked against the live
  map, not just the sheets.

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
- **No automated tests at all.** Everything has been verified by hand in a browser. The geometry and
  distance maths (haversine, `minDistanceToPaths`, the Dijkstra in `shortestStreetPath`) is pure and
  easily testable, and it is exactly the code where a silent error would make the app lie about
  whether a street is safe.
- **`renderPins` redraws every pin on every change.** Fine at today's scale, not at a city's.

## Rules that must not be broken

1. **Never publish authorship.** `pins_with_scores` exposes `is_mine`, never `user_id`; `votes` and
   `pin_confirmations` are not readable by other users. Grouping pins by author reconstructs where an
   individual walks and when.
2. **Bump `safewalk-app/version.json`** on any client change, or open apps keep running the old build.
3. **Migrations are append-only.** Never edit an applied file in `backend/`; add the next number.
4. **Only the anon key belongs in the repo.** Never the `service_role` key or the database password.
5. **Walking and biking only.** Never car routing — the app is for people on foot.
