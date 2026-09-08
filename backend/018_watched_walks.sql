-- SafeWalk — migration 018: watched walks
--
-- A walk someone else can follow while it happens. The whole feature is a movement trace by
-- definition, so the shape of this table is the privacy design, not a detail of it.
--
-- 1. ONLY THE LATEST POSITION IS STORED, overwritten in place. There is no breadcrumb table and no
--    history, deliberately: a watcher needs to know where you are now, and nobody — including us,
--    including a future feature, including whoever eventually gets hold of a backup — needs the
--    path you took. This is the same argument as migration 017, applied before the data exists
--    rather than after.
-- 2. THE ROW EXPIRES. Twelve hours, then it stops resolving and is purged. A walk home is over in
--    forty minutes; anything still readable next week is a liability with no purpose.
-- 3. THE WATCHER NEVER TOUCHES THIS TABLE. anon and authenticated get no select on it at all. A
--    watcher holds an unguessable token and calls one function that returns the walk's public face
--    — status, last position, times — and never walker_id, never the token of any other walk.
--
-- The token is a capability: whoever holds the link can watch. That is the point (the person you
-- most want watching is a parent who will not install anything), and it means the link is a secret
-- in the same way a door key is. Expiry is what bounds the damage of a shared one.

create table if not exists walks (
  id                uuid primary key default gen_random_uuid(),
  walker_id         uuid not null references auth.users(id) on delete cascade,
  -- Unguessable, and separate from id so the row's own identifier is never the thing shared.
  share_token       uuid not null default gen_random_uuid(),
  status            text not null default 'walking'
                      check (status in ('walking', 'arrived', 'cancelled', 'alarm')),
  -- Free text from the walker: "home from work". Shown to the watcher, so it is theirs to choose.
  label             text,
  -- Overwritten on every update. Never appended to.
  last_lat          double precision,
  last_lng          double precision,
  last_position_at  timestamptz,
  started_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '12 hours'
);

create unique index if not exists walks_share_token_idx on walks (share_token);
create index if not exists walks_walker_idx on walks (walker_id, started_at desc);
create index if not exists walks_expiry_idx on walks (expires_at);

alter table walks enable row level security;

-- The walker owns their walks completely. Nobody else reaches this table by any path.
drop policy if exists walks_own on walks;
create policy walks_own on walks
  for all
  using (auth.uid() = walker_id)
  with check (auth.uid() = walker_id);

-- Supabase grants table privileges to anon/authenticated by default, which is the exact gap
-- migrations 006 and 012 were both written to close. Do it here before there is anything to leak.
revoke all on walks from anon, authenticated, public;
grant select, insert, update, delete on walks to authenticated;

-- The watcher's only door. security definer so it can read a table the caller cannot, with
-- search_path pinned — migration 008 exists because an unpinned one is a privilege-escalation hole.
--
-- Returns nothing at all for an unknown, expired or finished-and-purged token, which is also the
-- answer for a guessed one: no distinction between "wrong token" and "no such walk".
create or replace function walk_by_token(p_token uuid)
returns table (
  status            text,
  label             text,
  last_lat          double precision,
  last_lng          double precision,
  last_position_at  timestamptz,
  started_at        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select w.status, w.label, w.last_lat, w.last_lng, w.last_position_at, w.started_at
  from walks w
  where w.share_token = p_token
    and w.expires_at > now();
$$;

revoke all on function walk_by_token(uuid) from public;
grant execute on function walk_by_token(uuid) to anon, authenticated;

-- Expiry has to actually delete, not merely hide. A row that stops resolving but stays in the table
-- is still a record of where somebody was, and "we filter it out in the query" is not a retention
-- policy. pg_cron is already in use for the police sync (migration 010).
create or replace function purge_expired_walks()
returns void
language sql
security definer
set search_path = public
as $$
  delete from walks where expires_at < now();
$$;

revoke all on function purge_expired_walks() from public, anon, authenticated;

select cron.schedule(
  'purge-expired-walks',
  '17 * * * *',
  $$select purge_expired_walks();$$
);
