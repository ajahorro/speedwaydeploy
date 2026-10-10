-- Services added to a booking after it was made ("add a service") were stored with the service name only, so the
-- sales report's "Top services" listed them as "Unknown" (it reads the name recorded when the booking was made).
--   1. fill the recorded name for every line that has none
--   2. record it automatically on every new line from now on
--   3. the report falls back to the line's own name before it ever says "Unknown"

update public.booking_vehicle_services
   set service_name_snapshot = service_name
 where coalesce(service_name_snapshot, '') = ''
   and coalesce(service_name, '') <> '';

create or replace function public.fill_service_name_snapshot()
returns trigger
language plpgsql
as $$
begin
  if coalesce(new.service_name_snapshot, '') = '' then
    new.service_name_snapshot := nullif(new.service_name, '');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fill_service_name_snapshot on public.booking_vehicle_services;
create trigger trg_fill_service_name_snapshot
  before insert on public.booking_vehicle_services
  for each row execute function public.fill_service_name_snapshot();

do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.sales_report(timestamptz,timestamptz)'::regprocedure) into v_def;
  v_new := replace(v_def,
    'coalesce(nullif(bvs.service_name_snapshot, ''''), ''Unknown'')',
    'coalesce(nullif(bvs.service_name_snapshot, ''''), nullif(bvs.service_name, ''''), ''Unknown'')');
  if v_new = v_def then
    raise exception 'sales_report layout changed; patch not applied';
  end if;
  execute v_new;
end
$patch$;
