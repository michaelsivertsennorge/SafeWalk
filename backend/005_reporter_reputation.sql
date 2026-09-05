-- SafeWalk — migration 005: reporter reputation from route feedback
--
-- When someone finishes a route and says it felt safe or unsafe, that verdict is evidence about
-- every pin along it. A pin marked "safe" by someone, on a route the walker then reported as
-- unsafe, is a contradiction; one that matches is a confirmation. Enough contradictions and the
-- author stops being allowed to add new pins for a while.
--
-- Two things this design is deliberately careful about, because getting them wrong would hurt the
-- people the app exists to protect:
--
-- 1. The client never learns who authored a pin. Recording a judgement therefore cannot happen in
--    the browser — it would need pins.user_id, which migration 003 removed from the public view on
--    purpose. Instead the work happens inside a SECURITY DEFINER function: it can read authorship
--    to write the row, and returns nothing that would reveal it.
--
-- 2. Disagreement is not the same as dishonesty. A street really can be fine at 6pm and frightening
--    at 2am, and someone who correctly flags a dangerous street will be contradicted by everyone who
--    walked it without incident. A naive counter would silence exactly the warnings this app exists
--    to surface. So the cooldown needs a minimum volume of evidence, a clear majority, and it
--    expires on its own as old judgements age out of the window.

-- ---------------------------------------------------------------------------
-- One row per (pin, judge). The primary key is what stops someone walking the
-- same route ten times to bury a reporter they dislike.
-- ---------------------------------------------------------------------------
create table if not exists pin_confirmations (
  pin_id     uuid not null references pins on delete cascade,
  judge_id   uuid not null references auth.users on delete cascade,
  author_id  uuid not null references auth.users on delete cascade,
  agreed     boolean not null,
  created_at timestamptz not null default now(),
  primary key (pin_id, judge_id)
);
create index if not exists pin_conf_author_idx on pin_confirmations (author_id, created_at desc);

alter table pin_confirmations enable row level security;

-- Nobody reads this table directly. It maps pins to their authors, so exposing it would undo the
-- privacy work in migration 003. Everything anyone legitimately needs comes from my_standing().
drop policy if exists pin_conf_read_none on pin_confirmations;
create policy pin_conf_read_none on pin_confirmations for select using (false);

-- ---------------------------------------------------------------------------
-- Thresholds. Deliberately forgiving: the cost of wrongly silencing an honest
-- reporter is much higher than the cost of letting a careless one continue a
-- little longer.
-- ---------------------------------------------------------------------------
create or replace function pin_cooldown_window() returns interval
language sql immutable as $$ select interval '30 days' $$;

create or replace function pin_cooldown_min_judgements() returns integer
language sql immutable as $$ select 8 $$;      -- below this, no penalty at all

create or replace function pin_cooldown_ratio() returns numeric
language sql immutable as $$ select 0.70 $$;   -- contradicted this often, and only then

-- ---------------------------------------------------------------------------
-- record_route_judgement — called once when a walker rates a finished route.
-- Takes the pins that lay along it and the verdict, and records agreement for
-- each. Returns how many judgements it stored, and nothing about who wrote what.
-- ---------------------------------------------------------------------------
create or replace function record_route_judgement(p_pin_ids uuid[], p_rating text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'must be signed in';
  end if;
  if p_rating not in ('safe', 'danger') then
    raise exception 'rating must be safe or danger';
  end if;

  insert into pin_confirmations (pin_id, judge_id, author_id, agreed)
  select p.id, auth.uid(), p.user_id, (p.creator_rating = p_rating)
  from pins p
  where p.id = any(p_pin_ids)
    and p.user_id is not null
    and p.user_id <> auth.uid()   -- you cannot grade your own homework
  on conflict (pin_id, judge_id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function record_route_judgement(uuid[], text) from public;
grant execute on function record_route_judgement(uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- Is this author currently in cooldown? Rolling, so it lifts by itself as old
-- contradictions fall out of the window — no unban queue, no permanent mark.
-- ---------------------------------------------------------------------------
create or replace function is_in_pin_cooldown(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select count(*) >= pin_cooldown_min_judgements()
        and count(*) filter (where not agreed)::numeric
            / greatest(count(*), 1) >= pin_cooldown_ratio()
     from pin_confirmations
     where author_id = p_uid
       and created_at > now() - pin_cooldown_window()),
    false);
$$;

-- ---------------------------------------------------------------------------
-- my_standing — what the app shows you about yourself, and only yourself.
-- There is no way to ask this about another person: harassment potential, and
-- a public accuracy score would chill exactly the reports we want.
-- ---------------------------------------------------------------------------
create or replace function my_standing()
returns table (
  confirmations  bigint,
  contradictions bigint,
  in_cooldown    boolean,
  cooldown_until timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) filter (where agreed)                                     as confirmations,
    count(*) filter (where not agreed)                                 as contradictions,
    is_in_pin_cooldown(auth.uid())                                     as in_cooldown,
    case when is_in_pin_cooldown(auth.uid())
         then min(created_at) + pin_cooldown_window()
    end                                                                as cooldown_until
  from pin_confirmations
  where author_id = auth.uid()
    and created_at > now() - pin_cooldown_window();
$$;

revoke all on function my_standing() from public;
grant execute on function my_standing() to authenticated;

-- ---------------------------------------------------------------------------
-- Enforce the cooldown where it actually counts: the database, not the UI.
-- Hiding the button would stop an honest user and nobody else.
-- ---------------------------------------------------------------------------
drop policy if exists pins_insert_own on pins;
create policy pins_insert_own on pins for insert
  with check (auth.uid() = user_id and not is_in_pin_cooldown(auth.uid()));
