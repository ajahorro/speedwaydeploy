-- Payment QR images become files + links (the server stores the file; see /api/admin/qr-image).
-- 1. list_inline_qr_images(): every QR picture still saved as text (data:image/...) in the settings or bookings.
-- 2. replace_inline_qr_images(map): swaps each such text for its file link, {old text: link}.
-- 3. The change history drops its old copies of the booking QR picture (new copies already stopped).
-- Nothing is deleted: the same pictures stay viewable through their links.

create or replace function public.list_inline_qr_images()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct v), '{}') from (
    select unnest(array[payment_qr_url, gcash_qr_url, qr_photo_url]) v from public.business_config
    union all
    select e.value #>> '{}' from public.bookings b, jsonb_each(coalesce(b.active_qr_snapshot, '{}')) e
     where jsonb_typeof(e.value) = 'string'
  ) s where v like 'data:image/%'
$$;

create or replace function public.replace_inline_qr_images(p_map jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n_cfg int; n_bk int;
begin
  set local session_replication_role = replica; -- a data move, not an edit: no history rows, no booking rules
  update public.business_config
     set payment_qr_url = coalesce(p_map ->> payment_qr_url, payment_qr_url),
         gcash_qr_url   = coalesce(p_map ->> gcash_qr_url, gcash_qr_url),
         qr_photo_url   = coalesce(p_map ->> qr_photo_url, qr_photo_url)
   where payment_qr_url like 'data:image/%' or gcash_qr_url like 'data:image/%' or qr_photo_url like 'data:image/%';
  get diagnostics n_cfg = row_count;
  update public.bookings b
     set active_qr_snapshot = (select jsonb_object_agg(e.key,
                                 case when jsonb_typeof(e.value) = 'string' and p_map ? (e.value #>> '{}')
                                      then p_map -> (e.value #>> '{}') else e.value end)
                                 from jsonb_each(b.active_qr_snapshot) e)
   where b.active_qr_snapshot::text like '%data:image/%';
  get diagnostics n_bk = row_count;
  return jsonb_build_object('settings', n_cfg, 'bookings', n_bk);
end $$;

revoke all on function public.list_inline_qr_images() from public, anon, authenticated;
revoke all on function public.replace_inline_qr_images(jsonb) from public, anon, authenticated;
grant execute on function public.list_inline_qr_images() to service_role;
grant execute on function public.replace_inline_qr_images(jsonb) to service_role;

-- 3. old copies out of the change history (rules paused only for this statement's transaction)
do $$ begin
  set local session_replication_role = replica;
  update public.audit_trails
     set old_data = old_data - 'active_qr_snapshot', new_data = new_data - 'active_qr_snapshot'
   where old_data ? 'active_qr_snapshot' or new_data ? 'active_qr_snapshot';
end $$;
