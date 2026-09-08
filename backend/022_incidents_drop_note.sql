-- SafeWalk — migration 022: incident reports carry no free text
--
-- The owner's call, and the right one. The note was the only field in an incident report that could
-- carry a description of a person, and no constraint can stop it: "tall man in a grey hoodie" fits
-- in 140 characters and passes every check in the schema. Every other safeguard in 019 and 021 was
-- about keeping this from becoming a way to report people, and then the form offered a free text box
-- and asked politely.
--
-- The alternative considered was keeping it, unpublished, for a future admin to moderate against.
-- Rejected, for two reasons:
--
--   Collecting personal data about third parties for a purpose that does not exist yet is exactly
--   what data minimisation forbids, and this app is operated in the EEA. A store of unreviewed
--   accusations nobody reads is a liability with no benefit until the day it leaks.
--
--   It would not help moderation much anyway. What a moderator needs is the category, the place, the
--   time and who disputed it — all of which are already recorded. The free text is the part that
--   creates the problem, not the part that solves it.
--
-- Nothing useful is lost. Context about a PLACE — "no lighting past the underpass" — belongs on a
-- rating pin, which already has notes and is a far lighter claim than asserting a crime occurred.
-- An incident says what happened, where, and when; that is the whole of what it should say.
--
-- Re-adding a column later is a one-line migration. Un-collecting text already gathered is not, so
-- the reversible direction is to drop it now.

alter table incidents drop column if exists note;

-- The view selected it, so it has to be rebuilt without it. Everything else is unchanged from 019:
-- tallies but never voters, hour-resolution times, no user_id, and nothing voted down.
create or replace view incidents_public as
  select
    i.id,
    i.category,
    i.lat,
    i.lng,
    date_trunc('hour', i.occurred_at) as occurred_at,
    i.expires_at,
    i.user_id = auth.uid() as is_mine,
    coalesce(v.up, 0)   as confirmed,
    coalesce(v.down, 0) as disputed
  from incidents i
  left join lateral (
    select sum(case when iv.vote = 1  then (case when iv.nearby then 2 else 1 end) else 0 end) as up,
           sum(case when iv.vote = -1 then (case when iv.nearby then 2 else 1 end) else 0 end) as down
    from incident_votes iv where iv.incident_id = i.id
  ) v on true
  where i.expires_at > now()
    and not (coalesce(v.down, 0) >= 3 and coalesce(v.down, 0) > coalesce(v.up, 0));

grant select on incidents_public to anon, authenticated;
