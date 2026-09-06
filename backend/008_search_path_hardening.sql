-- SafeWalk — migration 008: pin down search_path on our own functions
--
-- Found by Supabase's security linter. A function without an explicit search_path resolves names
-- against whatever the caller's search_path happens to be, so anyone able to create objects in an
-- earlier schema could shadow a function it calls. pins_set_geom matters most: it is a trigger
-- that runs on every pin write and calls PostGIS functions by bare name.
--
-- postgis lives in the public schema on this project, so the path must include public; an empty
-- search_path would break st_point.

create or replace function pins_set_geom() returns trigger
language plpgsql
set search_path = public, pg_temp
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

create or replace function pin_cooldown_window() returns interval
language sql immutable set search_path = pg_catalog, pg_temp as $$ select interval '30 days' $$;

create or replace function pin_cooldown_min_judgements() returns integer
language sql immutable set search_path = pg_catalog, pg_temp as $$ select 8 $$;

create or replace function pin_cooldown_ratio() returns numeric
language sql immutable set search_path = pg_catalog, pg_temp as $$ select 0.70 $$;

-- Deliberately NOT changing pins_near. Any SET clause makes a SQL function non-inlinable, and
-- pins_near exists precisely so st_dwithin can be inlined into an indexed GiST scan; pinning its
-- path could quietly turn the spatial lookup into a sequential one. It is SECURITY INVOKER and
-- takes no privileges the caller lacks. Revisit if it ever becomes SECURITY DEFINER, and measure
-- the plan with real data first.
