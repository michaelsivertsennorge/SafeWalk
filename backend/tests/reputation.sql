-- SafeWalk — reputation system self-test
--
-- Paste into the Supabase SQL editor and Run. It creates throwaway users and judgements, checks
-- every boundary, and ROLLS BACK — nothing is left behind. Safe to run against production.
--
-- This exists because the reputation system decides whether someone is allowed to warn other
-- people about a street, and none of it could be exercised from the client-side test suites: the
-- checks need two different signed-in users and the ability to age records. It was verified once by
-- hand; this is that verification written down.
--
-- Expected output, all three tables:
--
--   boundaries:  7/100% -> false | 8/100% -> true | 8/75% -> true
--                10/60% -> false | 10/70% -> true | 20/0%  -> false
--   lifecycle:   clean -> allowed | in cooldown -> blocked | aged out -> allowed again
--   privacy:     pin_confirmations readable by its own writer -> 0 rows

begin;

-- --------------------------------------------------------------------------
-- Fixtures: one author (the first real pin's owner) and twenty throwaway judges.
-- --------------------------------------------------------------------------
create temp table t_author as select user_id as id from pins where user_id is not null limit 1;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
select ('20000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'reputation-selftest-' || i || '@example.invalid', 'x', now(), now()
from generate_series(1, 20) i;

-- --------------------------------------------------------------------------
-- 1. Thresholds. The important one is the volume floor: someone contradicted
--    seven times out of seven must NOT be silenced, or a small group of
--    dissenters could mute a reporter who is right.
-- --------------------------------------------------------------------------
create temp table boundaries(scenario text, judgements int, contradicted text, in_cooldown boolean);

do $$
declare author uuid; scen record; i int;
begin
  select id into author from t_author;
  for scen in select * from (values
      ('below the volume floor',  7,  7),
      ('at the volume floor',     8,  8),
      ('75 percent contradicted', 8,  6),
      ('60 percent contradicted', 10, 6),
      ('70 percent exactly',      10, 7),
      ('nothing contradicted',    20, 0)
    ) as t(label, n, bad)
  loop
    delete from pin_confirmations where author_id = author;
    for i in 1..scen.n loop
      insert into pin_confirmations (pin_id, judge_id, author_id, agreed, created_at)
      values ((select id from pins limit 1),
              ('20000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
              author, i > scen.bad, now());
    end loop;
    insert into boundaries
    select scen.label, scen.n, round(scen.bad * 100.0 / scen.n) || '%',
           (select count(*) >= pin_cooldown_min_judgements()
               and count(*) filter (where not agreed)::numeric / greatest(count(*),1) >= pin_cooldown_ratio()
            from pin_confirmations
            where author_id = author and created_at > now() - pin_cooldown_window());
  end loop;
end $$;

-- --------------------------------------------------------------------------
-- 2. Enforcement. The threshold is only meaningful if the policy acts on it,
--    and the cooldown is only fair if it actually expires.
-- --------------------------------------------------------------------------
create temp table lifecycle(stage text, outcome text);
grant insert on lifecycle to authenticated;

delete from pin_confirmations where author_id = (select id from t_author);

do $$
declare author uuid;
begin
  select id into author from t_author;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', author, 'role', 'authenticated')::text, true);
  begin
    insert into pins (user_id, kind, lat, lng, creator_rating) values (author, 'spot', 59.92, 10.75, 'safe');
    insert into lifecycle values ('1. clean record', 'allowed');
  exception when others then insert into lifecycle values ('1. clean record', 'BLOCKED: ' || SQLERRM); end;
  reset role;
end $$;

insert into pin_confirmations (pin_id, judge_id, author_id, agreed, created_at)
select (select id from pins limit 1), ('20000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
       (select id from t_author), false, now() from generate_series(1,10) i;

do $$
declare author uuid;
begin
  select id into author from t_author;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', author, 'role', 'authenticated')::text, true);
  begin
    insert into pins (user_id, kind, lat, lng, creator_rating) values (author, 'spot', 59.93, 10.76, 'safe');
    insert into lifecycle values ('2. in cooldown', 'ALLOWED - NOT ENFORCED');
  exception when others then insert into lifecycle values ('2. in cooldown', 'blocked as intended'); end;
  reset role;
end $$;

update pin_confirmations set created_at = now() - interval '31 days'
 where author_id = (select id from t_author);

do $$
declare author uuid;
begin
  select id into author from t_author;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', author, 'role', 'authenticated')::text, true);
  begin
    insert into pins (user_id, kind, lat, lng, creator_rating) values (author, 'spot', 59.94, 10.77, 'safe');
    insert into lifecycle values ('3. aged out (31 days)', 'allowed again');
  exception when others then insert into lifecycle values ('3. aged out (31 days)', 'BLOCKED: ' || SQLERRM); end;
  reset role;
end $$;

-- --------------------------------------------------------------------------
-- 3. Privacy. pin_confirmations maps pins to their authors, so nobody may read
--    it — not even the person whose judgement created the row.
-- --------------------------------------------------------------------------
create temp table privacy(check_name text, rows_visible bigint);
grant insert on privacy to authenticated;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims',
    '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
  insert into privacy select 'pin_confirmations readable by its own writer', count(*) from pin_confirmations;
  reset role;
end $$;

select * from boundaries;
select * from lifecycle order by stage;
select * from privacy;

rollback;
