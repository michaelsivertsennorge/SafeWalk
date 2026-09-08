-- SafeWalk — migration 021: remove the "fighting or aggression" incident category
--
-- The owner spotted it as redundant with assault and unsafe-place, which it is. The stronger reason
-- to remove it is the one that only shows on a second look: of the five categories 019 shipped,
-- "a fight, or an aggressive group" was the closest thing to "scary" that survived the filter 019
-- was written to apply.
--
-- 019's first rule is that a category must name an EVENT, never a person, because every app in this
-- category that offered a people-shaped option ended up with reports skewed hard against minorities
-- and homeless people. "An aggressive group" is people-shaped. It invites "I saw some men who
-- worried me", which is exactly the report this app must not collect — and unlike assault or
-- robbery, nothing about it is checkable by anyone who was not there.
--
-- Nothing is lost by dropping it. A fight is people being attacked, which is `assault`; a place that
-- feels menacing without a specific event is `hazard`. The two are also the same instruction to
-- whoever reads the map: avoid this. Four options are quicker to choose between one-handed in the
-- dark than five, which is its own argument.
--
-- Safe to apply: verified that no incident row used it (the table was empty, all prior rows being
-- test data that had been cleaned up). Were any to exist, they would need remapping to 'assault'
-- before the constraint could be tightened.

alter table incidents drop constraint if exists incidents_category_check;

alter table incidents add constraint incidents_category_check
  check (category in ('assault', 'robbery', 'harassment', 'hazard'));
