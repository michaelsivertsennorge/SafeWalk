-- SafeWalk — migration 006: close two holes in the reputation functions
--
-- Found by testing 005 with the public anon key rather than trusting the grants:
--
-- 1. `revoke all ... from public` did not do what it looked like it did. Supabase ships
--    ALTER DEFAULT PRIVILEGES granting EXECUTE on new public-schema functions directly to anon and
--    authenticated, and revoking from PUBLIC does not remove a direct grant to a named role. So
--    my_standing() cheerfully answered a signed-out caller.
--
-- 2. Worse, is_in_pin_cooldown(uuid) took the user id as an argument and was SECURITY DEFINER, so
--    anyone holding the public key could ask "is THIS person suspended?" about any account id they
--    had. That is authorship-adjacent information about a named individual, which is exactly what
--    migration 003 set out to keep private.
--
-- The fix for (2) is to remove the argument entirely: the function now answers only about the
-- caller. There is no longer a question to ask about someone else, rather than a check that could
-- be forgotten. The RLS policy still works because policies evaluate as the calling user.

-- The policy depends on the old signature, so it has to go first.
drop policy if exists pins_insert_own on pins;
drop function if exists is_in_pin_cooldown(uuid);

create function is_in_pin_cooldown()
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
     where author_id = auth.uid()
       and created_at > now() - pin_cooldown_window()),
    false);
$$;

create policy pins_insert_own on pins for insert
  with check (auth.uid() = user_id and not is_in_pin_cooldown());

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
    count(*) filter (where agreed),
    count(*) filter (where not agreed),
    is_in_pin_cooldown(),
    case when is_in_pin_cooldown()
         then min(created_at) + pin_cooldown_window()
    end
  from pin_confirmations
  where author_id = auth.uid()
    and created_at > now() - pin_cooldown_window();
$$;

-- Revoke from the named roles, not just PUBLIC — that was the whole bug.
revoke all on function my_standing()               from public, anon;
revoke all on function is_in_pin_cooldown()        from public, anon;
revoke all on function record_route_judgement(uuid[], text) from public, anon;

grant execute on function my_standing()            to authenticated;
grant execute on function is_in_pin_cooldown()     to authenticated;
grant execute on function record_route_judgement(uuid[], text) to authenticated;

-- The threshold helpers leak nothing (they return constants) but there is no reason for the public
-- key to reach them either.
revoke all on function pin_cooldown_window()          from public, anon;
revoke all on function pin_cooldown_min_judgements()  from public, anon;
revoke all on function pin_cooldown_ratio()           from public, anon;
grant execute on function pin_cooldown_window()         to authenticated;
grant execute on function pin_cooldown_min_judgements() to authenticated;
grant execute on function pin_cooldown_ratio()          to authenticated;
