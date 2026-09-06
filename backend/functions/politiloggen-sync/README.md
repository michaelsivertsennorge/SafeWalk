# politiloggen-sync

Mirrors Norwegian police incident reports (politiet.no, NLOD 2.0) into `police_events`.

Deployed as a Supabase Edge Function. The canonical source is `index.ts` here — if you change the
deployed version, update this file too, or the next person will edit the wrong copy.

## Running it

```
curl -H "Authorization: Bearer $ANON_KEY" -H "apikey: $ANON_KEY" \
  "https://cxvwxqjbyplyvxufibii.supabase.co/functions/v1/politiloggen-sync?municipality=Oslo&take=50"
```

Add `&dry=1` to see what it *would* insert without writing. Add `&allCategories=1` to bypass the
category filter (useful for inspecting what is being excluded).

`take` is capped at 50 by Politiloggen itself; asking for more returns a 400.

## Why it exists server-side

Politiloggen blocks CORS, so a browser cannot call it. Writing to `police_events` also needs the
service role — clients have read-only access to that table.

## What it decides, and why

**Which incidents.** Politiloggen is mostly traffic and fires. Across 50 Oslo messages: 21 Trafikk,
13 Brann, 6 Savnet, 5 Andre hendelser, 3 Voldshendelse, 2 Ro og orden. A car crash does not make a
street unsafe to walk down, and painting the map red for one would bury the incidents that do. Only
`Voldshendelse` and `Ro og orden` are mirrored.

**Where.** Only a municipality and a free-text area are given, never coordinates. Geocoding that
text is unreliable in a way that matters — "Fuglevik, Råde" once resolved to Kristiansand, 230 km
away — so every result is verified against the municipality the police stated, and anything that
disagrees is dropped rather than guessed.

**How precisely.** Measured Nominatim bounding boxes: `Skullerud` ~1.1 km, `Sentrum` ~2.3 km,
`Filipstad` ~4.4 km, and `Økern` does not geocode at all. Drawing all of those as identical dots
would invent a corner the police never named, so the radius is stored and the map draws the area
actually described. Anything vaguer than `MAX_RADIUS_M` (2.5 km) is dropped.

## Known limits

- Nominatim has real gaps in Norwegian coverage. `Økern` — a well-known Oslo district — returns no
  result, so those incidents are silently skipped. Verified this is not rate-limiting: `Skullerud`
  succeeds in the same second.
- The police often name a specific street in the free text ("...i Rådhusgata...") while the `area`
  field says only "Sentrum". Extracting street names from `text` would give far better precision
  and is the single most valuable improvement available here.
- Nothing schedules this yet. It needs a cron trigger, or incidents go stale and expire unrefreshed.
