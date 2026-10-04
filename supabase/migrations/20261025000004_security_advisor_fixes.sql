-- ============================================================================
-- Supabase Security Advisor fixes.
--
-- 1. RLS disabled in public (CRITICAL): eight tables were readable and writable
--    by anyone holding the public anon key. None of them is read by the app
--    (frontend, backend or Edge Functions); the only database reader of
--    service_requirements is a SECURITY DEFINER function, and app_singletons is
--    read through default_admin_id() (made SECURITY DEFINER below). Enabling
--    RLS with no policies leaves them to service-role / definer code only.
--
-- 2. Security definer views (CRITICAL): three views ran with their owner's
--    rights, bypassing the callers' RLS. They now run as the caller
--    (security_invoker), so the underlying tables' policies apply.
--
-- 3. Function search_path mutable (WARN): functions without a fixed
--    search_path can be redirected by objects created earlier on the path.
--    Every such public function is pinned to `public, extensions`, which is
--    the project's existing default path, so behaviour does not change.
-- ============================================================================

-- ── 1. Row Level Security on the exposed tables ─────────────────────────────
alter table public.app_singletons         enable row level security;
alter table public.promo_services         enable row level security;
alter table public.promo_vehicle_types    enable row level security;
alter table public.promos                 enable row level security;
alter table public.service_bays           enable row level security;
alter table public.service_pricing_matrix enable row level security;
alter table public.service_requirements   enable row level security;
alter table public.test_bookings          enable row level security;

-- Defense in depth: the browser roles never had a legitimate use for these.
revoke all on table
  public.app_singletons, public.promo_services, public.promo_vehicle_types,
  public.promos, public.service_bays, public.service_pricing_matrix,
  public.service_requirements, public.test_bookings
from anon;

-- The default-admin guard reads app_singletons through this helper; it must
-- keep working for every caller now that the table is protected.
create or replace function public.default_admin_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(value, '')::uuid from public.app_singletons where key = 'default_admin_id';
$$;

-- ── 2. Views run with the caller's permissions ──────────────────────────────
alter view public.active_promo_services_view set (security_invoker = true);
alter view public.booking_service_lines      set (security_invoker = true);
alter view public.schedule_capacity_config   set (security_invoker = true);

-- ── 3. Fixed search_path for every public function that lacks one ──────────
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
       and not exists (
         select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'
       )
       -- Leave functions owned by extensions alone.
       and not exists (
         select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
       )
  loop
    execute format('alter function %s set search_path = public, extensions', fn.signature);
  end loop;
end $$;
