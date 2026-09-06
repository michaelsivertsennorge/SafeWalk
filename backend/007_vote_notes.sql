-- SafeWalk — migration 007: stop throwing away the notes people leave with a vote
--
-- The bug: the route-feedback sheet asks "tell us how it felt" and offers a note field, but
-- persistVote() only ever sent pin_id, user_id and rating. votes.note has existed since
-- migration 001 and nothing has ever written to it, and pins_with_scores never read it. The note
-- was pushed into the in-memory pin so it appeared briefly, then vanished on the next load — for
-- the person who wrote it as well as everyone else.
--
-- That is the most valuable thing a rating can carry. "Mostly reported unsafe" tells you very
-- little; "no lighting past the underpass, fine before 10pm" tells you what to actually do.
--
-- Privacy: notes are exposed as text + rating only. No user id, and deliberately no timestamp.
-- Timestamps across several pins could be lined up to reconstruct one person's route and when they
-- walked it, which is exactly what migration 003 removed user_id to prevent. Ordering happens
-- inside the aggregate, where created_at never leaves the database.

drop function if exists pins_near(double precision, double precision, integer);
drop view if exists pins_with_scores;

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
  coalesce(count(v.*) filter (where v.rating = 'danger'), 0) as danger_count,
  -- Capped at 20: a pin with hundreds of notes would bloat every map load, and the newest ones
  -- are the ones worth reading.
  coalesce(
    (select jsonb_agg(n)
     from (
       select jsonb_build_object('text', v2.note, 'rating', v2.rating) as n
       from votes v2
       where v2.pin_id = p.id
         and v2.note is not null
         and length(btrim(v2.note)) > 0
       order by v2.created_at desc
       limit 20
     ) recent),
    '[]'::jsonb
  ) as vote_notes
from pins p
left join votes v on v.pin_id = p.id
group by p.id;

create function pins_near(p_lat double precision, p_lng double precision, p_radius_m integer)
returns setof pins_with_scores
language sql stable
as $$
  select * from pins_with_scores
  where st_dwithin(geom, st_setsrid(st_point(p_lng, p_lat), 4326)::geography, p_radius_m);
$$;
