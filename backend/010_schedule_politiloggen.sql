-- SafeWalk — migration 010: actually run the Politiloggen sync on a schedule
--
-- Without this the edge function only runs when someone calls it by hand, so incidents go stale
-- and expire without being refreshed — a feature that looks finished but quietly does nothing.
-- pg_cron calls it hourly through pg_net.
--
-- The key below is the anon key, which is public by design (it already ships in
-- safewalk-app/config.js to every browser). It grants nothing on its own; the edge function does
-- its privileged work with the service role, which never leaves the server.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('politiloggen-hourly')
where exists (select 1 from cron.job where jobname = 'politiloggen-hourly');

select cron.schedule(
  'politiloggen-hourly',
  '7 * * * *',
  $job$
  select net.http_post(
    url := 'https://cxvwxqjbyplyvxufibii.supabase.co/functions/v1/politiloggen-sync?municipality=Oslo&take=50',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnd4cWpieXBseXZ4dWZpYmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MjU2NzMsImV4cCI6MjEwNDIwMTY3M30.ssSV4BfgePTD34pt9NjQCSFezJKAxGNyE-QQwrgYufw',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4dnd4cWpieXBseXZ4dWZpYmlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MjU2NzMsImV4cCI6MjEwNDIwMTY3M30.ssSV4BfgePTD34pt9NjQCSFezJKAxGNyE-QQwrgYufw'
    ),
    timeout_milliseconds := 55000
  );
  $job$
);

-- Old incidents are kept a while after expiry so a bad geocode can be audited, but not forever.
select cron.unschedule('police-events-prune')
where exists (select 1 from cron.job where jobname = 'police-events-prune');

select cron.schedule(
  'police-events-prune',
  '23 4 * * *',
  $job$ delete from police_events where expires_at < now() - interval '30 days'; $job$
);
