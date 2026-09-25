-- ============================================================================
-- Batch 1 Additions — Scenario 22: Prerequisite enforcement (server-side)
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Services can now declare a `requires` prerequisite (e.g. the "Waxx Add-on"
-- requires a wash on the same vehicle). The client validates this, but a stale
-- tab or a hand-crafted payload to create_booking_atomic could still submit an
-- isolated dependent service. The database must be the final authority.
--
-- THE FIX
-- -------
-- `validate_booking_service_requirements(p_vehicles jsonb)` walks the SAME
-- payload create_booking_atomic receives and raises a clean check_violation
-- ('requires ...') when a dependent service lacks its sibling. We patch
-- create_booking_atomic to call it right after the no-vehicles integrity shield,
-- so the booking is rejected BEFORE any row is written (no phantom, no partial).
--
-- The requirement map is a small, explicit table so new prerequisites can be
-- added without a code deploy.
-- ============================================================================

-- ── 1. Prerequisite map ─────────────────────────────────────────────────────
create table if not exists public.service_requirements (
  service_name  text not null,
  requires_any  text[] not null,
  primary key (service_name)
);

comment on table public.service_requirements is
  'Scenario 22: sibling services that must be present on the SAME vehicle. requires_any = at least one must be selected.';

-- Seed the add-on prerequisites (idempotent). Matches the `requires` metadata in
-- frontend/src/data/servicesCatalog.js.
insert into public.service_requirements (service_name, requires_any) values
  ('Waxx Add-on',      array['Regular Wash', 'Supreme Wash']),
  ('Highgloss Add-on', array['Regular Wash', 'Supreme Wash']),
  ('Degreaser Add-on', array['Regular Wash', 'Supreme Wash'])
on conflict (service_name) do update set requires_any = excluded.requires_any;


-- ── 2. Validation function ──────────────────────────────────────────────────
create or replace function public.validate_booking_service_requirements(p_vehicles jsonb)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_vehicle jsonb;
  v_names   text[];
  v_svc     jsonb;
  v_name    text;
  v_req     text[];
  v_ok      boolean;
begin
  if p_vehicles is null or jsonb_typeof(p_vehicles) <> 'array' then
    return;
  end if;

  for v_vehicle in select * from jsonb_array_elements(p_vehicles)
  loop
    -- Collect the lowercased service names on this vehicle.
    select coalesce(array_agg(lower(btrim(s ->> 'service_name'))), '{}'::text[])
      into v_names
      from jsonb_array_elements(coalesce(v_vehicle -> 'services', '[]'::jsonb)) as s;

    for v_svc in select * from jsonb_array_elements(coalesce(v_vehicle -> 'services', '[]'::jsonb))
    loop
      v_name := btrim(coalesce(v_svc ->> 'service_name', ''));
      continue when v_name = '';

      select sr.requires_any into v_req
        from public.service_requirements sr
       where lower(sr.service_name) = lower(v_name)
       limit 1;

      if v_req is null or array_length(v_req, 1) is null then
        continue; -- no prerequisite declared for this service
      end if;

      -- Satisfied when at least ONE listed prerequisite is present.
      select exists (
        select 1 from unnest(v_req) as r
         where lower(btrim(r)) = any (v_names)
      ) into v_ok;

      if not v_ok then
        raise exception '"%" requires % on the same vehicle.', v_name, array_to_string(v_req, ' or ')
          using errcode = 'check_violation';
      end if;
    end loop;
  end loop;
end;
$$;

comment on function public.validate_booking_service_requirements(jsonb) is
  'Scenario 22: raises check_violation when a dependent service lacks its required sibling on the same vehicle. Called by create_booking_atomic before any row is written.';

revoke all on function public.validate_booking_service_requirements(jsonb) from public;
grant execute on function public.validate_booking_service_requirements(jsonb) to authenticated;


-- ── 3. Patch create_booking_atomic to enforce it ────────────────────────────
do $$
declare
  v_src text;
  v_patched text;
begin
  select pg_get_functiondef(p.oid)
    into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'create_booking_atomic'
   limit 1;

  if v_src is null then
    raise notice 'create_booking_atomic() not found — skipping Scenario 22 patch.';
    return;
  end if;

  v_patched := v_src;

  if position('validate_booking_service_requirements' in v_patched) = 0 then
    -- Insert the prerequisite check right after the no-vehicles integrity shield.
    v_patched := replace(
      v_patched,
      '  -- 1. Master booking row ----------------------------------------------------',
      '  -- SC-22: reject an isolated dependent service before writing anything.' || chr(10) ||
      '  perform public.validate_booking_service_requirements(v_vehicles);' || chr(10) || chr(10) ||
      '  -- 1. Master booking row ----------------------------------------------------'
    );
  end if;

  if v_patched = v_src then
    raise notice 'create_booking_atomic() anchor not found — Scenario 22 patch skipped (already patched?).';
  else
    execute v_patched;
  end if;
end $$;