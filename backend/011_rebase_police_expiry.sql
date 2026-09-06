-- SafeWalk — migration 011: re-base police expiry onto the incident time
--
-- Rows written before the two-tier policy carried "synced_at + 12 hours", so a brawl from 01:00
-- would still have been on the map at 13:00 the next day. Expiry now follows when the incident
-- happened and whether the police say it is still running:
--
--   ongoing  -> 24h (a safety net; the hourly sync refreshes status, so this only bites if the
--                    feed stalls)
--   resolved -> 6h  (still matters on tonight's walk home, gone by tomorrow evening)

update police_events
set expires_at = occurred_at + (case when is_active then interval '24 hours' else interval '6 hours' end)
where occurred_at is not null;
