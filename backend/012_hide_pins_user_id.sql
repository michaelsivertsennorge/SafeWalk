-- SafeWalk — migration 012: stop the raw pins table publishing user_id
--
-- Found by the hourly maintenance agent; reproduced here before acting on it.
--
-- Migration 003 removed user_id from pins_with_scores so nobody could group pins by author and
-- reconstruct where one person walks. That fix only ever touched the VIEW. The table underneath
-- kept `pins_read using (true)` plus Supabase's default table-level SELECT grant to anon, so this
-- worked with nothing but the public key:
--
--   GET /rest/v1/pins?select=user_id,lat,lng,created_at&order=user_id
--   -> [{"user_id":"05048979-…","lat":59.9339387,"lng":10.7825532,"created_at":"…20:38:54"},
--       {"user_id":"05048979-…","lat":59.9339846,"lng":10.7807743,"created_at":"…20:39:47"}]
--
-- Two pins, one author, coordinates and timestamps: exactly the reconstruction 003 existed to
-- prevent. Migration 006 found this same default-privilege gap for FUNCTIONS, and nobody thought
-- to check whether it applied to tables. It did.
--
-- Fixed with column-level grants rather than revoking SELECT outright: the map is meant to be
-- publicly readable and every column except user_id is fine to publish. Direct table reads keep
-- working for everything legitimate — including persistCreate's insert(...).select('id') — while
-- user_id becomes unreachable. The view is unaffected either way; it runs with the owner's rights.

revoke select on pins from anon, authenticated, public;

grant select (
  id, kind, lat, lng, path, radius_m, street_name,
  creator_rating, creator_note, source, created_at, geom
) on pins to anon, authenticated;

-- votes and pin_confirmations are already row-restricted (own rows only, and none respectively),
-- so a column grant would add nothing. police_events is public by design.
