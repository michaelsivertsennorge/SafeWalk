-- SafeWalk — migration 016: prune the geocode skip-list alongside the events
--
-- A decision not to place an incident is only useful while that incident could still be shown.
-- Police events live 6-24 hours and are themselves pruned after 30 days, so anything older than
-- that in the skip-list is answering a question nobody will ask again.
--
-- Folded into the existing nightly job rather than adding a second one: it is the same concern,
-- runs on the same data, and one job is easier to reason about than two that must stay in step.

select cron.unschedule('police-events-prune')
where exists (select 1 from cron.job where jobname = 'police-events-prune');

select cron.schedule(
  'police-events-prune',
  '23 4 * * *',
  $job$
    delete from police_events where expires_at < now() - interval '30 days';
    delete from police_geocode_failures where tried_at < now() - interval '30 days';
  $job$
);
