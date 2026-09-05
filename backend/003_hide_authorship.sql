-- SafeWalk — migration 003: stop publishing who marked what
--
-- The problem this fixes: pins_with_scores selected p.*, which includes user_id, and votes was
-- readable by anyone. The ids are UUIDs rather than names, but that is not much comfort here —
-- group the pins by user_id and you have a map of where one particular woman walks, and the
-- timestamps say when. For an app whose users are marking the places they feel unsafe, that is
-- the single worst thing the database could leak, and the public API key is all it took to read it.
--
-- After this migration the client can still tell which pins are its own, because the view answers
-- that question directly (is_mine) instead of handing out the raw id for the client to compare.
--
-- Run in Supabase → SQL Editor after 002. Safe to re-run.

drop function if exists pins_near(double precision, double precision, integer);
drop view if exists pins_with_scores;

-- Columns are listed explicitly rather than p.*: with a wildcard, any column added to pins later
-- would be published automatically, which is how the user_id leak happened in the first place.
create view pins_with_scores as
select
  p.id,
  p.kind,
  p.lat,
  p.lng,
  p.path,
  p.radius_m,
  p.street_name,
  p.creator_rating,
  p.creator_note,
  p.source,
  p.created_at,
  p.geom,
  (p.user_id = auth.uid())                                   as is_mine,
  coalesce(count(v.*) filter (where v.rating = 'safe'), 0)   as safe_count,
  coalesce(count(v.*) filter (where v.rating = 'danger'), 0) as danger_count
from pins p
left join votes v on v.pin_id = p.id
group by p.id;

-- The view intentionally runs with the owner's rights (security_invoker stays off). That is what
-- lets it count everyone's votes for the public tally while the votes table itself stays private
-- below — the aggregate is public, the individual ballots are not.

create function pins_near(lat double precision, lng double precision, radius_m integer)
returns setof pins_with_scores
language sql stable
as $$
  select * from pins_with_scores
  where st_dwithin(geom, st_point(lng, lat)::geography, radius_m);
$$;

-- ---------------------------------------------------------------------------
-- Votes become private to the person who cast them. Nothing in the app needs
-- to read anyone else's row: the counts come from the view, and the only other
-- question the client asks is "have I already voted here?".
-- ---------------------------------------------------------------------------
drop policy if exists votes_read on votes;
create policy votes_read_own on votes for select using (auth.uid() = user_id);
