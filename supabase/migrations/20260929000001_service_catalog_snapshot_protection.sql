alter table if exists public.bookings
  add column if not exists service_snapshot jsonb default '[]'::jsonb,
  add column if not exists service_snapshot_version integer default 1;

alter table if exists public.booking_vehicle_services
  add column if not exists service_id uuid,
  add column if not exists service_snapshot jsonb default null,
  add column if not exists final_price numeric(12,2) default 0,
  add column if not exists price_at_booking numeric(12,2) default 0,
  add column if not exists base_price numeric(12,2) default 0,
  add column if not exists vehicle_type text,
  add column if not exists service_version integer default 1;

update public.bookings
set service_snapshot = '[]'::jsonb
where service_snapshot is null;

update public.bookings
set service_snapshot_version = 1
where service_snapshot_version is null;

update public.booking_vehicle_services
set service_version = 1
where service_version is null;

update public.booking_vehicle_services
set base_price = coalesce(price, 0)
where base_price is null;

update public.booking_vehicle_services
set final_price = coalesce(price, 0)
where final_price is null;

update public.booking_vehicle_services
set price_at_booking = coalesce(price, 0)
where price_at_booking is null;

update public.booking_vehicle_services
set vehicle_type = coalesce(vehicle_type, 'Sedan')
where vehicle_type is null;

create index if not exists idx_booking_vehicle_services_service_id
  on public.booking_vehicle_services (service_id);

create index if not exists idx_booking_vehicle_services_service_name
  on public.booking_vehicle_services (service_name);

create index if not exists idx_booking_vehicle_services_vehicle_type
  on public.booking_vehicle_services (vehicle_type);

comment on column public.bookings.service_snapshot is 'Immutable, booking-time snapshot of all selected services to protect historical records from later catalog edits or archiving.';
comment on column public.bookings.service_snapshot_version is 'Schema version for the immutable booking snapshot payload.';
comment on column public.booking_vehicle_services.service_id is 'Stable catalog identifier for the service as it existed when the booking was created.';
comment on column public.booking_vehicle_services.service_snapshot is 'Frozen copy of the catalog entry so historical bookings remain stable even after catalog edits or archive/restore operations.';
comment on column public.booking_vehicle_services.final_price is 'Immutable final line-item price at the time the booking was created.';
comment on column public.booking_vehicle_services.price_at_booking is 'Booking-time line-item price, kept immutable for historical billing and receipt rendering.';
comment on column public.booking_vehicle_services.base_price is 'Business catalog price at the time of booking; used for audit traceability.';
comment on column public.booking_vehicle_services.service_version is 'Catalog version identifier representing the service snapshot in force when the booking was created.';
