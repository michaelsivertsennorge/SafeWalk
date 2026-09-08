-- SafeWalk — migration 023: drop the unused profiles table
--
-- Found while auditing what the app actually stores, in order to write a privacy policy that is
-- true rather than plausible. `profiles(id, display_name, created_at)` has existed since early on,
-- is referenced nowhere in the client — the only `display_name` matches in app.js are Nominatim's
-- own response field, which is unrelated — and holds zero rows.
--
-- It is dropped rather than left alone because of what it is: a table whose whole purpose is to
-- attach a human name to an account, in an app built so that no contribution can ever be traced to
-- a person. Leaving it there is an invitation for a future feature to start filling it in, and the
-- day it holds names is the day "your name is never shown" needs re-checking rather than being
-- structurally true. Collecting nothing is the only version of that promise nobody can break by
-- accident.
--
-- Empty, so nothing is lost. Re-adding a table is a one-line migration if a display name is ever
-- genuinely wanted — and that should be a deliberate decision with the privacy note updated, which
-- is exactly what dropping it now forces.

drop table if exists profiles;
