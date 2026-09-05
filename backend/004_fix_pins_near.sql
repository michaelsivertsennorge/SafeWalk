-- SafeWalk — migration 004: fix pins_near returning nothing
--
-- The bug: pins_near's parameters were named lat, lng and radius_m. Migration 002 then added
-- columns with exactly those names to pins, and therefore to pins_with_scores. In a SQL-language
-- function PostgreSQL gives a *column* precedence over a same-named parameter, so the body
--
--   where st_dwithin(geom, st_point(lng, lat)::geography, radius_m)
--
-- quietly stopped meaning "within radius_m of the point the caller asked about" and started
-- meaning "within this pin's own radius_m of itself". radius_m is NULL for spots and streets, so
-- the predicate evaluated to NULL and the function returned zero rows — for every input, including
-- a pin's own exact coordinates and a 5000 km radius. No error, no warning: just an empty result
-- that looked like "no pins nearby".
--
-- The fix is the p_ prefix, which cannot collide with a column. The parameter names are part of
-- the API (PostgREST passes arguments by name), so callers now send p_lat / p_lng / p_radius_m.
--
-- Run in Supabase → SQL Editor after 003. Safe to re-run.

drop function if exists pins_near(double precision, double precision, integer);

create function pins_near(p_lat double precision, p_lng double precision, p_radius_m integer)
returns setof pins_with_scores
language sql stable
as $$
  select * from pins_with_scores
  where st_dwithin(geom, st_setsrid(st_point(p_lng, p_lat), 4326)::geography, p_radius_m);
$$;
