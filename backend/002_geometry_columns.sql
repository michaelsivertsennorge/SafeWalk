-- SafeWalk — migration 002: plain lat/lng/path columns
--
-- Why: the app draws pins from plain numbers and arrays, but PostGIS returns geom as an opaque
-- binary blob over the REST API. Rather than decode that in the browser, the app writes lat/lng
-- (and path, for streets) and a trigger keeps the PostGIS geom column in sync for the spatial
-- index. So the client stays simple and "pins within 1 km of me" stays a fast indexed query.
--
-- Run this in Supabase → SQL Editor after schema.sql. Safe to re-run.

alter table pins add column if not exists lat  double precision;
alter table pins add column if not exists lng  double precision;
alter table pins add column if not exists path jsonb;   -- [[ [lat,lng], [lat,lng], ... ]] for streets

-- geom is now derived, so it must not block inserts that only supply lat/lng.
alter table pins alter column geom drop not null;

-- ---------------------------------------------------------------------------
-- Keep geom in sync with whatever the client wrote.
-- A street becomes a LineString (so distance is measured to the nearest point
-- of the stretch, not its midpoint); everything else becomes a Point.
-- ---------------------------------------------------------------------------
create or replace function pins_set_geom() returns trigger
language plpgsql
as $$
declare
  line geometry;
begin
  if new.path is not null and jsonb_typeof(new.path) = 'array'
     and jsonb_array_length(new.path) > 0
     and jsonb_typeof(new.path -> 0) = 'array'
     and jsonb_array_length(new.path -> 0) > 1 then
    select st_makeline(array_agg(
             st_setsrid(st_point((pt ->> 1)::float8, (pt ->> 0)::float8), 4326)
             order by ord))
      into line
      from jsonb_array_elements(new.path -> 0) with ordinality as t(pt, ord);
    new.geom := line::geography;
  elsif new.lat is not null and new.lng is not null then
    new.geom := st_setsrid(st_point(new.lng, new.lat), 4326)::geography;
  end if;
  return new;
end;
$$;

drop trigger if exists pins_set_geom_trg on pins;
create trigger pins_set_geom_trg
  before insert or update of lat, lng, path on pins
  for each row execute function pins_set_geom();

-- ---------------------------------------------------------------------------
-- Rebuild the view and the RPC so both expose the new columns.
-- The function has to be dropped first: its return type is the view's row type,
-- which changes shape here.
-- ---------------------------------------------------------------------------
drop function if exists pins_near(double precision, double precision, integer);
drop view if exists pins_with_scores;

create view pins_with_scores as
select
  p.*,
  coalesce(count(v.*) filter (where v.rating = 'safe'), 0)   as safe_count,
  coalesce(count(v.*) filter (where v.rating = 'danger'), 0) as danger_count
from pins p
left join votes v on v.pin_id = p.id
group by p.id;

create function pins_near(lat double precision, lng double precision, radius_m integer)
returns setof pins_with_scores
language sql stable
as $$
  select * from pins_with_scores
  where st_dwithin(geom, st_point(lng, lat)::geography, radius_m);
$$;
