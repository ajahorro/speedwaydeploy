-- ============================================================================
-- Booking drafts: an unfinished booking survives a reload (and a change of
-- device) until it is submitted or the person presses Cancel.
--
-- One draft per person per wizard ('customer' = the customer booking wizard,
-- 'admin_walkin' = the admin walk-in wizard). Only the owner can see or change
-- it. Drafts hold what the person typed (vehicles, services, schedule, notes,
-- customer details); uploaded receipt files are never stored here.
-- ============================================================================
create table if not exists public.booking_drafts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('customer', 'admin_walkin')),
  step        integer not null default 1 check (step between 1 and 4),
  data        jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  constraint booking_drafts_one_per_user_kind unique (user_id, kind)
);

alter table public.booking_drafts enable row level security;

create policy booking_drafts_owner_select on public.booking_drafts
  for select to authenticated using (user_id = (select auth.uid()));
create policy booking_drafts_owner_insert on public.booking_drafts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy booking_drafts_owner_update on public.booking_drafts
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy booking_drafts_owner_delete on public.booking_drafts
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.booking_drafts from anon;

-- Keep the table small: a draft untouched for 30 days is dropped the next time
-- anyone saves one.
create or replace function public.booking_drafts_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  delete from public.booking_drafts where updated_at < now() - interval '30 days';
  return new;
end;
$$;

create trigger trg_booking_drafts_touch
  before insert or update on public.booking_drafts
  for each row execute function public.booking_drafts_touch();
