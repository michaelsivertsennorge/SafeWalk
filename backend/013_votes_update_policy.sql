-- SafeWalk — migration 013: editing your rating never updated your vote
--
-- Found by auditing every table's grants and policies together, after migration 012 showed that
-- fixing a class of bug in one place (functions, migration 006) says nothing about the others.
--
-- persistUpdate writes pins.creator_rating and then updates the matching votes row. votes had
-- SELECT, INSERT and DELETE policies but no UPDATE policy, and with RLS enabled a missing policy
-- denies silently — no error, zero rows affected. Reproduced as the owning user: setting a vote
-- from 'safe' to 'danger' left it 'safe'.
--
-- The consequence is not cosmetic. pins_with_scores derives safe_count and danger_count from
-- votes, and the map colour comes from those counts. So editing a pin from safe to unsafe changed
-- the label but not the tally, and the street kept showing green. On a map whose entire job is
-- saying whether a street is safe, that is the worst kind of silent failure.
--
-- Verified after applying, as the owning user: the vote becomes 'danger' and the derived counts
-- move from 1/0 to 0/1.

drop policy if exists votes_update_own on votes;
create policy votes_update_own on votes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
