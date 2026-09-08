-- SafeWalk — migration 019: incident reports
--
-- Different in kind from a rating, and the schema has to know it. A rating is an opinion about a
-- place. An incident report is an assertion that A CRIME HAPPENED at a time and place, published to
-- strangers. Two failure modes are documented in this exact product category — Citizen, Nextdoor,
-- Ring Neighbors all shipped them — and both are designed against here rather than retrofitted.
--
-- 1. IT MUST NOT BECOME A WAY TO REPORT PEOPLE. Every category names an EVENT, never a person: no
--    "suspicious", no "scary". Those invite a description of somebody who was standing there, and
--    everywhere they have shipped the reports skew hard against minorities and homeless people.
--    There is no photo column and no field for describing a person, and the note is capped short.
-- 2. IT MUST NOT BECOME A PERMANENT ACCUSATION. Incidents are news, not facts about a street, so
--    they expire after seven days and are purged. And they can be voted down by people who were
--    actually there.
--
-- Timestamps: rule 2 of ROADMAP.md forbids publishing other people's PIN times at better than day
-- resolution, because pins made minutes apart along a route reconstruct a walk. Incidents are
-- published at HOUR resolution instead, deliberately, because the reasoning does not transfer: a
-- pin is one of many along a path, an incident is a single exceptional event, and its recency is
-- most of its value — "an hour ago" and "six days ago" are different warnings. Hour granularity
-- keeps that while refusing to pin anyone to a minute.

create table if not exists incidents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  -- Events, not people. Extending this list is a product decision with a safety consequence.
  category    text not null check (category in ('assault', 'robbery', 'harassment', 'disturbance', 'hazard')),
  lat         double precision not null,
  lng         double precision not null,
  geom        geography(Point, 4326),
  -- About the place and what happened. Short on purpose: room for "no lighting by the underpass",
  -- not for a description of a person.
  note        text check (note is null or length(note) <= 140),
  occurred_at timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days'
);

create index if not exists incidents_geom_idx on incidents using gist (geom);
create index if not exists incidents_expiry_idx on incidents (expires_at);

create or replace function incidents_set_geom() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.geom := st_setsrid(st_point(new.lng, new.lat), 4326)::geography;
  return new;
end $$;

drop trigger if exists incidents_geom_trigger on incidents;
create trigger incidents_geom_trigger before insert or update on incidents
  for each row execute function incidents_set_geom();

-- Judgement by people who were there. `nearby` is the client's own claim that it was within a short
-- distance when voting, and it is a WEIGHT, never a gate — see ROADMAP.md, option 3. The client can
-- lie either way, so gating would block honest people with bad GPS and stop nobody determined; a
-- weight means a false claim buys a little influence rather than the right to erase a warning.
-- Crucially this stores no new fact about where anyone was: the vote already names a place.
create table if not exists incident_votes (
  incident_id uuid not null references incidents(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  vote        smallint not null check (vote in (-1, 1)),
  nearby      boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (incident_id, user_id)
);

alter table incidents enable row level security;
alter table incident_votes enable row level security;

drop policy if exists incidents_insert_own on incidents;
create policy incidents_insert_own on incidents for insert
  with check (auth.uid() = user_id and not is_in_pin_cooldown());

drop policy if exists incidents_modify_own on incidents;
create policy incidents_modify_own on incidents for update using (auth.uid() = user_id);

drop policy if exists incidents_delete_own on incidents;
create policy incidents_delete_own on incidents for delete using (auth.uid() = user_id);

-- Nobody reads the raw table. Same lesson as 012: the view is decoration while the table underneath
-- still hands over user_id and an exact timestamp.
revoke all on incidents from anon, authenticated, public;
grant insert, update, delete on incidents to authenticated;

-- A vote reveals who doubted whom. Writable by its owner, readable by nobody — as with `votes`.
drop policy if exists incident_votes_own on incident_votes;
create policy incident_votes_own on incident_votes for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on incident_votes from anon, authenticated, public;
grant insert, update, delete on incident_votes to authenticated;

-- The public face. Tallies but never voters, hour-resolution times, no user_id, and nothing that
-- the community has voted down.
create or replace view incidents_public as
  select
    i.id,
    i.category,
    i.lat,
    i.lng,
    i.note,
    date_trunc('hour', i.occurred_at) as occurred_at,
    i.expires_at,
    i.user_id = auth.uid() as is_mine,
    coalesce(v.up, 0)   as confirmed,
    coalesce(v.down, 0) as disputed
  from incidents i
  left join lateral (
    -- Someone who was there counts double. Not as a gate: see the note on incident_votes.
    select sum(case when iv.vote = 1  then (case when iv.nearby then 2 else 1 end) else 0 end) as up,
           sum(case when iv.vote = -1 then (case when iv.nearby then 2 else 1 end) else 0 end) as down
    from incident_votes iv where iv.incident_id = i.id
  ) v on true
  where i.expires_at > now()
    -- Hidden once enough weighted doubt outweighs the support. The floor of 3 is the same lesson as
    -- the reputation system's volume floor: without it, two people could erase a true warning.
    and not (coalesce(v.down, 0) >= 3 and coalesce(v.down, 0) > coalesce(v.up, 0));

grant select on incidents_public to anon, authenticated;

create or replace function incidents_near(p_lat double precision, p_lng double precision, p_radius_m integer)
returns setof incidents_public
language sql stable security definer set search_path = public as $$
  select * from incidents_public
  where st_dwithin(
    st_setsrid(st_point(lng, lat), 4326)::geography,
    st_setsrid(st_point(p_lng, p_lat), 4326)::geography,
    p_radius_m);
$$;

revoke all on function incidents_near(double precision, double precision, integer) from public;
grant execute on function incidents_near(double precision, double precision, integer) to anon, authenticated;

-- Expiry has to delete, not merely hide: a filtered-out row is still an accusation sitting in a
-- table. Same argument as the walks purge in 018.
create or replace function purge_expired_incidents() returns void
language sql security definer set search_path = public as $$
  delete from incidents where expires_at < now();
$$;
revoke all on function purge_expired_incidents() from public, anon, authenticated;

select cron.schedule('purge-expired-incidents', '23 * * * *', $$select purge_expired_incidents();$$);
