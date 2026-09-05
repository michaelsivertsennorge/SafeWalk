-- SafeWalk — database schema (migration 001)
-- Paste this whole file into the Supabase dashboard → SQL Editor → Run.
-- Safe to re-run: everything is created with "if not exists" or dropped-then-created.
--
-- Run the numbered migrations after this one, in order:
--   002_geometry_columns.sql  — lat/lng/path columns the client actually writes
--   003_hide_authorship.sql   — stops the view publishing who marked what
-- The view and pins_near defined below are both replaced by those, so setting up a fresh database
-- means running all three; this file alone leaves authorship exposed.

-- PostGIS gives us real geo queries ("pins within 1 km of me") as a single indexed lookup,
-- instead of looping over every pin in JavaScript like the prototype does today.
create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- profiles — public-facing user info. Credentials live in Supabase's auth.users.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users on delete cascade,
  display_name text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pins — one rated place: a spot, an area circle, or a stretch of street.
-- geom is a Point for spot/area and a LineString for street, which is why the
-- column is a generic Geometry rather than one specific type.
-- ---------------------------------------------------------------------------
create table if not exists pins (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users on delete set null,
  kind           text not null check (kind in ('spot', 'area', 'street')),
  geom           geography(Geometry, 4326) not null,
  radius_m       integer,       -- only meaningful for kind = 'area'
  street_name    text,          -- only meaningful for kind = 'street'
  creator_rating text not null check (creator_rating in ('safe', 'danger')),
  creator_note   text,
  source         text not null default 'manual' check (source in ('manual', 'route')),
  created_at     timestamptz not null default now()
);
create index if not exists pins_geom_idx on pins using gist (geom);
create index if not exists pins_user_idx on pins (user_id);

-- ---------------------------------------------------------------------------
-- votes — the database itself enforces one vote per person per pin via the
-- composite primary key. In the prototype this was only a per-device check,
-- which anyone could bypass by clearing their browser storage.
-- ---------------------------------------------------------------------------
create table if not exists votes (
  pin_id     uuid not null references pins on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  rating     text not null check (rating in ('safe', 'danger')),
  note       text,
  created_at timestamptz not null default now(),
  primary key (pin_id, user_id)
);

-- ---------------------------------------------------------------------------
-- police_events — incidents mirrored from Politiloggen (politiet.no, NLOD 2.0).
-- Written only by the server-side sync job; clients read but never write.
-- geom is nullable because plenty of entries can't be geocoded confidently.
-- ---------------------------------------------------------------------------
create table if not exists police_events (
  id           uuid primary key default gen_random_uuid(),
  external_id  text unique not null,   -- the Politiloggen message id, prevents duplicates
  category     text,
  municipality text,
  area         text,
  text_body    text,
  geom         geography(Point, 4326),
  is_active    boolean not null default true,
  occurred_at  timestamptz,
  expires_at   timestamptz             -- when it should stop showing on the map
);
create index if not exists police_geom_idx on police_events using gist (geom);
create index if not exists police_expiry_idx on police_events (expires_at);

-- ---------------------------------------------------------------------------
-- pins_with_scores — pins plus their vote tally, which is what the map draws.
-- ---------------------------------------------------------------------------
create or replace view pins_with_scores as
select
  p.*,
  coalesce(count(v.*) filter (where v.rating = 'safe'), 0)   as safe_count,
  coalesce(count(v.*) filter (where v.rating = 'danger'), 0) as danger_count
from pins p
left join votes v on v.pin_id = p.id
group by p.id;

-- ---------------------------------------------------------------------------
-- pins_near — the core query: everything within radius_m of a point.
-- Called from the client as supabase.rpc('pins_near', { lat, lng, radius_m }).
-- ---------------------------------------------------------------------------
create or replace function pins_near(lat double precision, lng double precision, radius_m integer)
returns setof pins_with_scores
language sql stable
as $$
  select * from pins_with_scores
  where st_dwithin(geom, st_point(lng, lat)::geography, radius_m);
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security. Without this every table would be world-writable via the
-- public API key, so these policies are load-bearing, not boilerplate.
-- ---------------------------------------------------------------------------
alter table profiles      enable row level security;
alter table pins          enable row level security;
alter table votes         enable row level security;
alter table police_events enable row level security;

-- Ratings are a shared public map: everyone can read them.
drop policy if exists pins_read on pins;
create policy pins_read on pins for select using (true);

-- ...but you may only create pins as yourself, and only edit/delete your own.
drop policy if exists pins_insert_own on pins;
create policy pins_insert_own on pins for insert with check (auth.uid() = user_id);

drop policy if exists pins_update_own on pins;
create policy pins_update_own on pins for update using (auth.uid() = user_id);

drop policy if exists pins_delete_own on pins;
create policy pins_delete_own on pins for delete using (auth.uid() = user_id);

drop policy if exists votes_read on votes;
create policy votes_read on votes for select using (true);

drop policy if exists votes_insert_own on votes;
create policy votes_insert_own on votes for insert with check (auth.uid() = user_id);

drop policy if exists votes_delete_own on votes;
create policy votes_delete_own on votes for delete using (auth.uid() = user_id);

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (true);

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update using (auth.uid() = id);

-- Police data is read-only to clients; the sync job writes with the service key,
-- which bypasses RLS by design.
drop policy if exists police_read on police_events;
create policy police_read on police_events for select using (true);
