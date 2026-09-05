# SafeWalk

A mobile web app for marking streets and areas as safe or unsafe, so people walking home alone at
night can see what others have found — and route around what they haven't.

Oslo is the default city. No API keys are needed to run it: the map is OpenStreetMap, routing is
Valhalla, geocoding is Nominatim, and street geometry comes from Overpass.

## Layout

| Path | What it is |
|---|---|
| `safewalk-app/` | The whole client. Static files — no build step, no bundler. |
| `safewalk-app/version.json` | **The deploy switch.** Bump this string and every open app reloads itself. |
| `backend/` | Numbered SQL migrations for Supabase. Run them in order. |
| `server.ps1` | Tiny static file server for local testing (raw TCP; `HttpListener` rejects tunnelled hosts). |

## Running it locally

```powershell
powershell -File server.ps1
```

Then open <http://localhost:5566>.

## Database

Supabase (Postgres + PostGIS + Row Level Security). Apply `backend/*.sql` in numeric order —
`schema.sql` is migration 001, and the later files change the view and the `pins_near` function, so
a fresh database needs all of them.

Reading the map is anonymous. Writing anything requires an account: "one vote per person" is
enforced by the `votes` table's `(pin_id, user_id)` primary key, which a device id could never do.

## About the keys

`safewalk-app/config.js` holds the Supabase **anon** key. That key is designed to be public and
grants nothing on its own — every table is behind Row Level Security, so what a request may read or
change is decided by the database. The `service_role` key and the database password are the secrets;
they must never appear in this repository or in client code.

## Privacy

The database deliberately does not publish who marked what. `pins_with_scores` exposes an `is_mine`
boolean instead of `user_id`, and `votes` rows are readable only by the person who cast them.
Grouping pins by author would otherwise reconstruct where an individual walks and when — the single
worst thing this dataset could leak, given who it is for.
