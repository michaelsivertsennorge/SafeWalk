-- SafeWalk — migration 014: mirror police incidents for the rest of Norway's larger cities
--
-- Until now only Oslo was synced, so the police layer was permanently blank for everyone else —
-- and Oslo alone does not produce enough to keep it useful. Measured on the live feed, the 50 most
-- recent Oslo messages held 5 in-scope incidents across four days.
--
-- Rate of in-scope incidents per city, measured 2026-09-07 over each city's 50 most recent messages
-- (violence, public order, and cordon/closure reports, after collapsing threads):
--
--     Trondheim    6.1/day      Drammen        1.0/day
--     Bergen       2.5/day      Tromsø         1.0/day
--     Kristiansand 1.3/day      Stavanger      0.4/day
--     Oslo         1.3/day      Fredrikstad    0.4/day
--                               Bærum          0.1/day
--
-- About 13 a day nationally. Sparse per city, which is the honest reason the map often shows
-- nothing: there genuinely is nothing, not because the sync is broken.
--
-- One job per city rather than one job looping over all of them. Each run keeps its own geocoding
-- budget, one city failing cannot starve the others, and — the real reason — Nominatim allows one
-- request a second per IP. Staggering five minutes apart means two cities can never geocode at
-- once, which a single looping job could not guarantee within one function invocation.
--
-- Minutes deliberately avoid :00 and :30, where every scheduler on the internet piles up.
--
-- The key below is the anon key: public by design, already shipped in safewalk-app/config.js to
-- every browser. It grants nothing on its own — the edge function does its privileged work with
-- the service role, which never leaves the server.

do $$
declare
  anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnd4cWpieXBseXZ4dWZpYmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MjU2NzMsImV4cCI6MjEwNDIwMTY3M30.ssSV4BfgePTD34pt9NjQCSFezJKAxGNyE-QQwrgYufw';
  base_url text := 'https://cxvwxqjbyplyvxufibii.supabase.co/functions/v1/politiloggen-sync';
  c record;
  job_name text;
begin
  for c in
    -- slug is the job name; encoded is the URL-safe municipality exactly as Politiloggen expects.
    select * from (values
      ('bergen',       'Bergen',       12),
      ('trondheim',    'Trondheim',    17),
      ('stavanger',    'Stavanger',    22),
      ('baerum',       'B%C3%A6rum',   27),
      ('kristiansand', 'Kristiansand', 32),
      ('drammen',      'Drammen',      37),
      ('tromso',       'Troms%C3%B8',  42),
      ('fredrikstad',  'Fredrikstad',  47)
    ) as t(slug, encoded, minute)
  loop
    job_name := 'politiloggen-' || c.slug;

    if exists (select 1 from cron.job where jobname = job_name) then
      perform cron.unschedule(job_name);
    end if;

    perform cron.schedule(
      job_name,
      c.minute || ' * * * *',
      format(
        'select net.http_post(url := %L, headers := jsonb_build_object(%L, %L, %L, %L, %L, %L), timeout_milliseconds := 55000);',
        base_url || '?municipality=' || c.encoded || '&take=50',
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || anon_key,
        'apikey', anon_key
      )
    );
  end loop;
end $$;
