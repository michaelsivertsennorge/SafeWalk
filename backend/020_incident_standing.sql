-- SafeWalk — migration 020: incident reports count towards your standing
--
-- 019 gated incident reporting behind the existing cooldown, so somebody already silenced for bad
-- pins cannot report incidents either. It did not close the loop the other way: a false incident
-- cost its reporter nothing, so the heaviest claim in the app — that a crime happened — was the one
-- with no consequence attached. Disputes are now judgements, exactly as they are for pins.
--
-- The one decision worth arguing about: **incident_confirmations does NOT reference incidents.**
-- Incidents are deleted after seven days by design (019), and a cascading foreign key would delete
-- the judgement along with the report. A serial false reporter would then be wiped clean every
-- week, which is precisely the person this exists to slow down. The reputation record has to outlive
-- the thing it is about, so incident_id is a plain uuid and the rows are purged on their own,
-- well after the 30-day cooldown window has stopped caring about them.

create table if not exists incident_confirmations (
  -- Deliberately no FK: see above. The report is temporary, the record of having been wrong is not.
  incident_id uuid not null,
  judge_id    uuid not null references auth.users(id) on delete cascade,
  author_id   uuid not null references auth.users(id) on delete cascade,
  agreed      boolean not null,
  created_at  timestamptz not null default now(),
  primary key (incident_id, judge_id)
);

create index if not exists incident_confirmations_author_idx
  on incident_confirmations (author_id, created_at desc);

alter table incident_confirmations enable row level security;
-- Readable by nobody, like pin_confirmations: it maps a report to its author and to who doubted
-- them, which is exactly the pairing that must never be public.
revoke all on incident_confirmations from anon, authenticated, public;

-- A vote becomes a judgement of whoever wrote the report. Changing your vote updates it rather than
-- stacking a second one, and voting on your own report is not a judgement of anybody.
create or replace function record_incident_judgement() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into incident_confirmations (incident_id, judge_id, author_id, agreed)
  select new.incident_id, new.user_id, i.user_id, (new.vote = 1)
  from incidents i
  where i.id = new.incident_id and i.user_id <> new.user_id
  on conflict (incident_id, judge_id)
    do update set agreed = excluded.agreed, created_at = now();
  return new;
end $$;

drop trigger if exists incident_votes_judgement on incident_votes;
create trigger incident_votes_judgement after insert or update on incident_votes
  for each row execute function record_incident_judgement();

-- Both kinds of judgement now count towards the same standing. A person whose incident reports are
-- consistently disputed is stopped from posting pins as well, and vice versa — both are claims about
-- whether somewhere is safe, and being repeatedly wrong about one is reason to pause the other.
-- The thresholds are untouched: 8 judgements minimum, 70% contradicted, 30-day window. The volume
-- floor is what stops a small group silencing someone who is right.
create or replace function is_in_pin_cooldown() returns boolean
language sql stable security definer set search_path = public as $$
  with judged as (
    select agreed from pin_confirmations
      where author_id = auth.uid() and created_at > now() - pin_cooldown_window()
    union all
    select agreed from incident_confirmations
      where author_id = auth.uid() and created_at > now() - pin_cooldown_window()
  )
  select coalesce((
    select count(*) >= pin_cooldown_min_judgements()
       and count(*) filter (where not agreed)::numeric / greatest(count(*), 1) >= pin_cooldown_ratio()
    from judged), false);
$$;

create or replace function my_standing()
returns table(confirmations bigint, contradictions bigint, in_cooldown boolean, cooldown_until timestamptz)
language sql stable security definer set search_path = public as $$
  with judged as (
    select agreed, created_at from pin_confirmations
      where author_id = auth.uid() and created_at > now() - pin_cooldown_window()
    union all
    select agreed, created_at from incident_confirmations
      where author_id = auth.uid() and created_at > now() - pin_cooldown_window()
  )
  select
    count(*) filter (where agreed),
    count(*) filter (where not agreed),
    is_in_pin_cooldown(),
    case when is_in_pin_cooldown() then min(created_at) + pin_cooldown_window() end
  from judged;
$$;

-- Long after the cooldown window has stopped reading them. Not cascaded from incidents, so this is
-- the only thing that ever removes them.
create or replace function purge_old_incident_confirmations() returns void
language sql security definer set search_path = public as $$
  delete from incident_confirmations where created_at < now() - interval '90 days';
$$;
revoke all on function purge_old_incident_confirmations() from public, anon, authenticated;

select cron.schedule('purge-old-incident-confirmations', '41 4 * * *',
  $$select purge_old_incident_confirmations();$$);
