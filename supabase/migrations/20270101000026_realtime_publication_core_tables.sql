-- bookings, booking_vehicles, notifications, and payments were enabled on supabase_realtime
-- directly on the live project at some point, but that was never captured in a migration.
-- Every realtime subscriber (admin dashboard, staff tasks, customer booking page, notification
-- bell) depends on these being in the publication; a fresh/restored environment seeded from
-- migrations alone would silently have none of them live. Idempotent: a no-op if already added.
do $do$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings') then
    execute 'alter publication supabase_realtime add table public.bookings';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'booking_vehicles') then
    execute 'alter publication supabase_realtime add table public.booking_vehicles';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'payments') then
    execute 'alter publication supabase_realtime add table public.payments';
  end if;
end;
$do$;
