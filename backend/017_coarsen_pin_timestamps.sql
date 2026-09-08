-- SafeWalk — migration 017: stop pin timestamps reconstructing a walk
--
-- Migration 003 removed user_id from the view, and 012 removed it from the table underneath, both
-- to stop anyone grouping pins by author and reconstructing where one person walks. 012 quoted the
-- attack it was closing:
--
--   GET /rest/v1/pins?select=user_id,lat,lng,created_at&order=user_id
--
-- Note what is still in that select list. Removing user_id closed the grouping key, but pins made
-- seconds apart along a contiguous path need no grouping key at all — the timestamps ARE the trail.
-- Two pins 40 metres apart, 53 seconds apart, on the same street, are one person walking, and that
-- was already true before this migration:
--
--   GET /rest/v1/pins?select=lat,lng,created_at&order=created_at
--
-- Walk mode makes it much worse, because producing a line of marks along one route in one evening
-- is now the app's intended behaviour rather than an accident of two people rating nearby spots.
-- A trail of six marks between a bar and a front door, at 23:40 on a Friday, describes a person.
--
-- Fixed by publishing pin ages at day resolution. Your own pins keep their exact time, because
-- your own movements are not a secret from you and My reports sorts by it. Everyone else's are
-- truncated, which puts every pin made that day into one indistinguishable bucket — the point is
-- not to blur the time but to destroy the ORDERING, since order plus geometry is what draws a path.
--
-- This costs nothing on screen: the app has only ever displayed pin age in whole days
-- (relativeDate() -> "Today" / "Yesterday" / "5d ago"). If a future version wants to say "20
-- minutes ago" on a fresh warning, this is the trade it has to reopen — deliberately, not by
-- forgetting.
--
-- The lesson of 012 was that fixing the view is not enough while the table grant still hands the
-- column over directly, so both are done here. Verified after applying, with the anon key, that
-- ?select=created_at on the table is refused and the view returns midnight.

create or replace view pins_with_scores as
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
    -- Functionally dependent on p.id (the primary key), so this is allowed alongside the group by.
    case when p.user_id = auth.uid() then p.created_at
         else date_trunc('day', p.created_at)
    end as created_at,
    p.geom,
    p.user_id = auth.uid() as is_mine,
    coalesce(count(v.*) filter (where v.rating = 'safe'), 0)   as safe_count,
    coalesce(count(v.*) filter (where v.rating = 'danger'), 0) as danger_count,
    coalesce((
      select jsonb_agg(recent.n)
      from (
        select jsonb_build_object('text', v2.note, 'rating', v2.rating) as n
        from votes v2
        where v2.pin_id = p.id and v2.note is not null and length(btrim(v2.note)) > 0
        order by v2.created_at desc
        limit 20
      ) recent
    ), '[]'::jsonb) as vote_notes
  from pins p
  left join votes v on v.pin_id = p.id
  group by p.id;

-- The half 012 taught us not to skip. Without this the view is decoration: the raw column is still
-- readable straight off the table by anyone holding the public key.
--
-- Nothing in the client reads created_at from the table — every read goes through the view, and the
-- only direct table calls are insert(...).select('id'), update() and delete(). Server-side callers
-- (the edge functions) use the service_role key, which grants bypass these entirely.
revoke select (created_at) on pins from anon, authenticated;
