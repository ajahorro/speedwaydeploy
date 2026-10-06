-- ============================================================================
-- Staff attendance and work history.
--
--   1. staff_attendance          one row per clock-in / clock-out, filled by a trigger on the profile so every
--                                way of clocking in or out is recorded the same way.
--   2. staff_clock_out_blockers  the reasons a technician may NOT clock out right now: a job already under way
--                                (started, or its before photo is saved) or a job that starts within 5 minutes.
--                                The server checks it before clocking out; a technician's own direct update is
--                                refused by a trigger too.
--   3. staff_work_history        the technician's history by day (clock-ins and the vehicles worked that day),
--                                a few days at a time. Technicians read their own, administrators anyone's.
-- ============================================================================

create table if not exists public.staff_attendance (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references public.profiles(id) on delete cascade,
  clock_in_at  timestamptz not null default now(),
  clock_out_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint staff_attendance_order check (clock_out_at is null or clock_out_at >= clock_in_at)
);
create index if not exists staff_attendance_staff_in_idx on public.staff_attendance (staff_id, clock_in_at desc);
create unique index if not exists staff_attendance_one_open_idx on public.staff_attendance (staff_id) where clock_out_at is null;

alter table public.staff_attendance enable row level security;
drop policy if exists staff_attendance_select on public.staff_attendance;
create policy staff_attendance_select on public.staff_attendance
  for select to authenticated
  using (staff_id = (select auth.uid()) or (select public.is_admin()));
revoke insert, update, delete on public.staff_attendance from anon, authenticated;
grant select on public.staff_attendance to authenticated;

-- people already on shift when this runs
insert into public.staff_attendance (staff_id, clock_in_at)
select p.id, coalesce(p.clock_in_timestamp, now())
  from public.profiles p
 where coalesce(p.is_clocked_in, false)
   and not exists (select 1 from public.staff_attendance a where a.staff_id = p.id and a.clock_out_at is null);

-- ── 1. record every clock-in / clock-out ───────────────────────────────────
create or replace function public.record_staff_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.is_clocked_in, false) and not coalesce(old.is_clocked_in, false) then
    insert into public.staff_attendance (staff_id, clock_in_at)
    values (new.id, coalesce(new.clock_in_timestamp, now()))
    on conflict (staff_id) where clock_out_at is null do nothing;
  elsif not coalesce(new.is_clocked_in, false) and coalesce(old.is_clocked_in, false) then
    update public.staff_attendance
       set clock_out_at = greatest(now(), clock_in_at)
     where staff_id = new.id and clock_out_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_record_staff_attendance on public.profiles;
create trigger trg_record_staff_attendance
  after update of is_clocked_in on public.profiles
  for each row
  when (old.is_clocked_in is distinct from new.is_clocked_in)
  execute function public.record_staff_attendance();

-- ── 2. who may not clock out ───────────────────────────────────────────────
-- A vehicle blocks clock-out when it is assigned to the technician, its booking is still open, it is not finished, and
--   * it is under way: started, or a before photo is already saved; or
--   * its booking starts within 5 minutes (or has already started and is waiting for the technician).
create or replace function public.staff_clock_out_blockers(p_staff uuid)
returns table (vehicle_id uuid, booking_id uuid, vehicle_label text, start_datetime timestamptz, reason text)
language sql
stable
security definer
set search_path = public
as $$
  select bv.id,
         b.id,
         trim(concat_ws(' ', coalesce(bv.brand, bv.make), bv.model, nullif(bv.plate_number, ''))),
         b.start_datetime,
         case when upper(coalesce(bv.status, '')) = 'IN_PROGRESS' then 'IN_PROGRESS'
              when exists (select 1 from public.service_photos sp where sp.booking_vehicle_id = bv.id and sp.phase = 'before') then 'BEFORE_PHOTO_SAVED'
              else 'STARTS_SOON' end
    from public.booking_vehicles bv
    join public.bookings b on b.id = bv.booking_id
   where bv.staff_id = p_staff
     and coalesce(bv.is_cancelled, false) = false
     and upper(coalesce(bv.status, '')) not in ('COMPLETED', 'CANCELLED')
     and lower(coalesce(b.status::text, '')) not in ('completed', 'cancelled', 'flagged_noshow', 'no_show')
     and (
       upper(coalesce(bv.status, '')) = 'IN_PROGRESS'
       or exists (select 1 from public.service_photos sp where sp.booking_vehicle_id = bv.id and sp.phase = 'before')
       or (b.start_datetime <= now() + interval '5 minutes' and b.start_datetime >= now() - interval '1 hour')
     )
   order by b.start_datetime;
$$;

revoke all on function public.staff_clock_out_blockers(uuid) from public, anon;
grant execute on function public.staff_clock_out_blockers(uuid) to service_role;

-- the signed-in technician's own blockers (the Duty page shows them before the button is pressed)
create or replace function public.my_clock_out_blockers()
returns table (vehicle_id uuid, booking_id uuid, vehicle_label text, start_datetime timestamptz, reason text)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.staff_clock_out_blockers(auth.uid());
$$;

revoke all on function public.my_clock_out_blockers() from public, anon;
grant execute on function public.my_clock_out_blockers() to authenticated;

-- the technician's own direct clock-out is refused while a blocker exists (the server relay checks the same function)
create or replace function public.guard_staff_clock_out()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.is_clocked_in, false) and not coalesce(new.is_clocked_in, false)
     and auth.uid() is not null and auth.uid() = new.id
     and exists (select 1 from public.staff_clock_out_blockers(new.id)) then
    raise exception 'You cannot clock out while you have a job under way or one starting within 5 minutes. Ask an admin to assign another staff member if you really need to clock out.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_staff_clock_out on public.profiles;
create trigger trg_guard_staff_clock_out
  before update of is_clocked_in on public.profiles
  for each row
  execute function public.guard_staff_clock_out();

-- ── 3. history by day ─────────────────────────────────────────────────────
-- A few days at a time, newest first. p_before = only days before this date (null = from today). A "day" is a day of the
-- shop (Manila) on which the technician clocked in or had a vehicle scheduled. Returns who/when only: no money.
create or replace function public.staff_work_history(p_staff uuid, p_before date default null, p_days integer default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 3), 31));
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if p_staff is distinct from auth.uid() and not public.is_admin() then
    raise exception 'You can only view your own history.' using errcode = '42501';
  end if;

  with att as (
    select a.id, a.clock_in_at, a.clock_out_at, (a.clock_in_at at time zone 'Asia/Manila')::date as day
      from public.staff_attendance a
     where a.staff_id = p_staff
  ),
  veh as (
    select bv.id, b.id as booking_id, (b.start_datetime at time zone 'Asia/Manila')::date as day,
           coalesce(bv.brand, bv.make) as brand, bv.model, bv.plate_number, bv.vehicle_type, bv.status,
           bv.started_at, bv.completed_at, bv.service_notes, b.start_datetime, b.customer_name,
           coalesce((select jsonb_agg(s.service_name order by s.step_order, s.created_at)
                       from public.booking_vehicle_services s where s.booking_vehicle_id = bv.id), '[]'::jsonb) as services
      from public.booking_vehicles bv
      join public.bookings b on b.id = bv.booking_id
     where bv.staff_id = p_staff
       and coalesce(bv.is_cancelled, false) = false
       and lower(coalesce(b.status::text, '')) <> 'cancelled'
  ),
  all_days as (
    select day from att union select day from veh
  ),
  picked as (
    select day from all_days
     where p_before is null or day < p_before
     order by day desc
     limit v_days + 1
  ),
  shown as (
    select day from picked order by day desc limit v_days
  )
  select jsonb_build_object(
           'days', coalesce((
             select jsonb_agg(jsonb_build_object(
               'day', s.day,
               'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at) order by a.clock_in_at)
                                       from att a where a.day = s.day), '[]'::jsonb),
               'vehicles', coalesce((select jsonb_agg(jsonb_build_object(
                                'id', v.id, 'booking_id', v.booking_id, 'brand', v.brand, 'model', v.model,
                                'plate_number', v.plate_number, 'vehicle_type', v.vehicle_type, 'status', v.status,
                                'started_at', v.started_at, 'completed_at', v.completed_at, 'service_notes', v.service_notes,
                                'start_datetime', v.start_datetime, 'customer_name', v.customer_name, 'services', v.services)
                                order by v.start_datetime)
                                from veh v where v.day = s.day), '[]'::jsonb)
             ) order by s.day desc)
             from shown s), '[]'::jsonb),
           'has_more', (select count(*) from picked) > v_days
         )
    into v_result;
  return v_result;
end;
$$;

revoke all on function public.staff_work_history(uuid, date, integer) from public, anon;
grant execute on function public.staff_work_history(uuid, date, integer) to authenticated;
