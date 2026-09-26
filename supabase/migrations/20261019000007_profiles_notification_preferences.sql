-- ============================================================================
-- 20261019000006_profiles_notification_preferences.sql
-- ============================================================================
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- The deployed site returns 400 on a request every signed-in customer makes:
--
--     GET /rest/v1/profiles?select=notification_preferences,push_notifications_enabled
--         &id=eq.<uuid>    ->  400 (Bad Request)
--
-- Cause: `notification_preferences` is SELECTED and WRITTEN by the client, and
-- read by the backend's notification fan-out, but the column was NEVER CREATED
-- on `profiles`. PostgREST answers an unknown column with 400, so the request
-- fails on every page load.
--
-- This is the same class of defect as the missing migrations found earlier: code
-- depends on a schema object that no migration ever created. The references are:
--
--   frontend/src/utils/preferenceStore.js       (read + write)
--   frontend/src/services/customerNotifyService.js (read)
--   backend/server.js                           (read, for opt-in fan-out)
--
-- The comments in preferenceStore.js even describe the column as "optional and
-- ... not selected here because older deployed schemas do not have it" — the
-- client was written to tolerate its absence, but other call sites select it
-- unconditionally and fail hard. Tolerating a missing column is not a substitute
-- for creating it.
--
-- DESIGN
-- ------
-- A JSONB object keyed by notification category, e.g.
--
--     { "emailBookingUpdates": true, "emailPromos": false, "pushEnabled": true }
--
-- JSONB (not a set of boolean columns) because the categories are product
-- decisions that will change, and the client already treats it as a merged map
-- (`{ ...local, ...data.notification_preferences }`). A key that does not exist
-- is simply absent, which every reader already handles.
--
-- DEFAULT: an empty object, NOT a populated one. `{}` means "no explicit
-- preference", which the backend correctly treats as NOT opted in. Seeding
-- opt-ins would silently start emailing customers who never consented.
--
-- `push_notifications_enabled` is a separate, legacy boolean other screens still
-- read, so it is ensured here too rather than being assumed present. The client
-- mirrors one into the other so they cannot disagree.
-- ============================================================================

alter table public.profiles
  add column if not exists notification_preferences jsonb not null default '{}'::jsonb;

comment on column public.profiles.notification_preferences is
  'Per-category notification opt-ins, e.g. {"emailBookingUpdates":true,"emailPromos":false}. An ABSENT key means "no explicit preference" and must be treated as NOT opted in — never seed this with true values, or customers who never consented will be emailed. Read by frontend/src/utils/preferenceStore.js, frontend/src/services/customerNotifyService.js and backend/server.js.';

-- Legacy boolean still read by other screens; the client keeps the two in sync.
alter table public.profiles
  add column if not exists push_notifications_enabled boolean not null default false;

comment on column public.profiles.push_notifications_enabled is
  'Legacy push opt-in flag. Mirrored into notification_preferences by the client so the two cannot disagree.';

-- A malformed value (an array or a scalar instead of an object) would break every
-- `prefs[key]` read and the backend's `notification_preferences[preferenceKey]`
-- opt-in check. Constrain it to an object so that cannot be stored at all.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_notification_preferences_is_object'
       and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_notification_preferences_is_object
      check (notification_preferences is null or jsonb_typeof(notification_preferences) = 'object')
      not valid;
  end if;
end $$;

-- Existing rows: normalise any NULL to the empty object so readers never have to
-- special-case it. (The column is NOT NULL DEFAULT going forward; this covers
-- rows written before the default existed.)
update public.profiles
   set notification_preferences = '{}'::jsonb
 where notification_preferences is null;

-- ── Opt-in helper ───────────────────────────────────────────────────────────
-- One authoritative reading of "has this customer opted into this category".
-- The backend and any future caller must agree; re-deriving `prefs[key] === true`
-- at each call site is how the two drift (a missing key, a string "true", or a
-- NULL row each behave differently depending on the implementation).
create or replace function public.customer_opted_in(
  p_user_id uuid,
  p_key     text
)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select (p.notification_preferences ->> p_key) = 'true'
       from public.profiles p
      where p.id = p_user_id),
    false
  );
$$;

comment on function public.customer_opted_in(uuid, text) is
  'TRUE only when profiles.notification_preferences contains the named key with the literal boolean true. An absent key, a NULL row, or any non-true value is FALSE — opt-in must be explicit, never inferred.';

revoke all on function public.customer_opted_in(uuid, text) from public;
grant execute on function public.customer_opted_in(uuid, text) to authenticated;