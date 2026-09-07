# SafeWalk

A mobile web app for marking streets and areas as safe or unsafe, so people walking home alone at
night can see what others have found — and route around what they haven't.

Oslo is the default city. No API keys are needed to run it: the map is OpenStreetMap, routing is
Valhalla, geocoding is Nominatim, and street geometry comes from Overpass.

## Layout

| Path | What it is |
|---|---|
| `safewalk-app/` | The whole client. Static files — no build step, no bundler. |
| `safewalk-app/geo.js` | Pure geometry, street-graph and routing maths. No DOM, no network — so it can be tested. |
| `safewalk-app/version.json` | **The deploy switch.** Bump this string and every open app reloads itself. |
| `backend/` | Numbered SQL migrations for Supabase. Run them in order. |
| `tests/` | Plain-Node tests, no framework. |
| `server.ps1` | Tiny static file server for local testing (raw TCP; `HttpListener` rejects tunnelled hosts). |

## Tests

```bash
node tests/geo.test.js          # pure maths — no network
node tests/permissions.test.js  # what the public API key can and cannot do (hits the live database)
```

Covers the maths that decides what the app tells you about a street: distances, the street graph and
its shortest paths, polyline decoding, and the rating bands. Exits non-zero on failure.

One check in there is not about maths at all. `geo.js` and `app.js` both load as classic scripts,
app.js second, so a same-named function in app.js silently replaces the tested one from geo.js —
which happened to `describeAge` and rendered "20704 days ago" on screen while this suite went on
passing, because it requires the module directly and never sees the shadowing. The guard compares
geo.js's exports against app.js's top-level declarations, and it was verified by reintroducing that
exact collision and watching it fail, then by feeding it an empty source to confirm it fails rather
than passing vacuously.

`permissions.test.js` is read-only by design: every write it attempts is expected to be refused,
and it verifies that by reading the data back rather than trusting a status code. A PATCH that
row-level security filtered to zero rows still returns 204, so status codes alone would have missed
the bug in migration 013.

It exists because every security bug in this project so far was found by hand, one at a time, and
three were the same mistake in different places — see the header comment. Each of those requests is
now written down.

There is a third suite that neither of those can cover. The reputation system decides whether
someone is allowed to warn other people about a street, and testing it needs two different
signed-in users plus the ability to age records — impossible from a browser or an anon key. Paste
`backend/tests/reputation.sql` into the Supabase SQL editor and Run: it creates throwaway users,
checks every threshold boundary and the full block-then-expire lifecycle, and rolls back. Nothing
is left behind, so it is safe against production.

These are deliberately dependency-free. The client has no build step, and a suite that needed one
would stop being run. They also encode bugs already found in real use — merge idempotency, snapping
to unreachable streets, the exact 75% band boundary — so those cannot come back unnoticed.

## Deploying

`.github/workflows/ci.yml` runs the maths suite on every push and pull request. That job is worth
more than it looks: the machine this is developed on has no Node, so the suite has only ever been
run through a browser shim that fakes `require()`. CI is the first place it runs the way this
README says to run it.

Publishing is opt-in, because putting SafeWalk on a public URL is the owner's decision rather than
something a push should do on its own. To turn it on:

1. **Settings → Pages → Source: "GitHub Actions"**
2. **Settings → Secrets and variables → Actions → Variables →** add `DEPLOY_PAGES` = `true`

The app then lands at `https://<user>.github.io/SafeWalk/` on every push to `main`. Only
`safewalk-app/` is published — `backend/` (SQL migrations, the edge function) and `tests/` stay out
of the web root. Nothing in the client is secret: `config.js` holds the Supabase **anon** key, which
is designed to be public and grants nothing on its own.

Until then the only way to reach it from a phone is `server.ps1` behind a tunnel, which hands out a
new hostname every restart and dies when the laptop sleeps. A real URL also means HTTPS, which is
what the service worker and geolocation need — so offline support can finally be tested on a device.

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
