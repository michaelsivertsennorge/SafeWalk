-- SafeWalk — migration 009: record how precisely a police incident is located
--
-- Politiloggen never gives coordinates, only a municipality and a free-text area, so location comes
-- from geocoding that text. Measured against Nominatim, precision varies enormously:
--
--   "Skullerud"  -> railway station, bounding box ~1.1 km across
--   "Sentrum"    -> suburb boundary,  bounding box ~2.3 km across
--   "Filipstad"  -> suburb boundary,  bounding box ~4.4 km across
--   "Økern"      -> no result at all
--
-- Drawing all of those as identical dots would be a lie in both directions: it invents a precise
-- corner the police never named, and three separate "Sentrum" incidents would stack into one
-- misleading point in the middle of the city. Storing the radius lets the map draw the area the
-- police actually described.

alter table police_events add column if not exists radius_m integer;
alter table police_events add column if not exists precision_label text;

comment on column police_events.radius_m is
  'Half the geocode bounding-box diagonal, in metres. The incident is somewhere in here, not at the centre.';
comment on column police_events.precision_label is
  'Nominatim addresstype the area resolved to (suburb, railway, road...). Kept so bad geocodes can be audited.';

drop policy if exists police_read on police_events;
create policy police_read on police_events for select using (true);

create index if not exists police_active_idx
  on police_events (expires_at)
  where expires_at is not null;
