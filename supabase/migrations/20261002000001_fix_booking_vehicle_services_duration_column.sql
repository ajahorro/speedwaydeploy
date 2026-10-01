alter table if exists public.booking_vehicle_services
  add column if not exists duration_minutes integer default 60;

update public.booking_vehicle_services
set duration_minutes = 60
where duration_minutes is null;

comment on column public.booking_vehicle_services.duration_minutes is 'Duration for the service line item at booking time; used by add-service and scheduling calculations.';
