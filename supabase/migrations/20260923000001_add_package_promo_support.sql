-- Package Promo support: ensure business_config.promo_rules is always an array
-- and expose an admin-only helper to write the promo catalogue atomically.
--
-- RLS from 20260921000002 already allows: authenticated SELECT (customers read
-- active packages) and admin-only INSERT/UPDATE. This migration adds guardrails
-- and a single write RPC so the admin UI and future /api/admin/packages route
-- share one code path.

do $$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'business_config'
      and column_name = 'promo_rules'
  ) then
    alter table public.business_config
      add column promo_rules jsonb not null default '[]'::jsonb;
  end if;
end $$;

-- Backfill any NULL/non-array values so the client never receives a non-array.
update public.business_config
set promo_rules = '[]'::jsonb
where promo_rules is null
   or jsonb_typeof(promo_rules) <> 'array';

-- Constraint: promo_rules must always be a JSON array (standard + package rules).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'business_config_promo_rules_is_array'
  ) then
    alter table public.business_config
      add constraint business_config_promo_rules_is_array
      check (jsonb_typeof(promo_rules) = 'array');
  end if;
end $$;

-- Admin-only RPC: replace the whole promo catalogue in one transaction.
-- Packages and standard promos live in the same JSONB array, discriminated by
-- the `mode` field ('standard' | 'package').
create or replace function public.set_promo_rules(p_rules jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_saved jsonb;
begin
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and upper(p.role) = 'ADMIN'
  ) into v_is_admin;

  if not v_is_admin then
    raise exception 'Admin access is required to update promo rules.';
  end if;

  if jsonb_typeof(p_rules) <> 'array' then
    raise exception 'promo_rules must be a JSON array.';
  end if;

  insert into public.business_config (id, promo_rules, updated_at)
  values (1, p_rules, now())
  on conflict (id) do update
    set promo_rules = excluded.promo_rules,
        updated_at = excluded.updated_at
  returning promo_rules into v_saved;

  return v_saved;
end;
$$;

grant execute on function public.set_promo_rules(jsonb) to authenticated;
