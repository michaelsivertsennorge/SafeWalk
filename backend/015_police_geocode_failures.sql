-- SafeWalk — migration 015: stop re-geocoding incidents we already know we cannot place
--
-- Every hour, for every city, the sync geocoded the same doomed incidents again. Observed in the
-- live run log: Kristiansand and Bærum each reported "relevant 1, dropped 1" on every single run,
-- hour after hour — the same report, the same Nominatim lookups, the same rejection for being too
-- vague to draw ("Lund" resolves to a 2.5km circle, wider than MAX_RADIUS_M).
--
-- Nominatim is free, asks for at most one request a second, and explicitly asks not to be used for
-- systematic querying. Hammering it hourly with a lookup we have already decided to throw away is
-- both rude and self-defeating: a 429 from Nominatim was observed during testing, which then costs
-- us the incidents we could have placed.
--
-- So a decision not to place an incident is remembered. message_count is stored with it, because
-- Politiloggen threads grow — a later update often names the street the first message omitted — so
-- a thread that has gained a message is worth trying again. Anything else is not.

create table if not exists police_geocode_failures (
  external_id   text primary key,
  municipality  text,
  area          text,
  reason        text,
  message_count int  not null default 1,
  tried_at      timestamptz not null default now()
);

comment on table police_geocode_failures is
  'Incidents the sync could not place well enough to draw. Exists to avoid re-asking Nominatim the same question every hour; not user-facing.';

alter table police_geocode_failures enable row level security;

-- No policies at all: nobody reaches this through PostgREST. The edge function writes it with the
-- service role, which bypasses RLS. Explicit revokes because Supabase's default privileges grant to
-- anon and authenticated directly, so revoking from PUBLIC alone would leave both able to read it.
revoke all on police_geocode_failures from anon, authenticated;

-- Cleared on the same schedule as the events themselves; a decision about an expired incident is
-- of no further use.
create index if not exists police_geocode_failures_tried_at_idx
  on police_geocode_failures (tried_at);
