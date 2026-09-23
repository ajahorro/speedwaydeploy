-- ============================================================================
-- Batch 7 / Step 7.5 follow-up: QR photo URL support for admin-managed payment QR
-- ============================================================================

alter table if exists public.business_config
  add column if not exists payment_qr_url text default '',
  add column if not exists gcash_qr_url text default '',
  add column if not exists qr_photo_url text default '';

update public.business_config
   set payment_qr_url = coalesce(payment_qr_url, '')
 where payment_qr_url is null;

update public.business_config
   set gcash_qr_url = coalesce(gcash_qr_url, payment_qr_url, '')
 where gcash_qr_url is null;

update public.business_config
   set qr_photo_url = coalesce(qr_photo_url, payment_qr_url, gcash_qr_url, '')
 where qr_photo_url is null;

-- Keep the live QR URL consistent across all naming variants the app already reads.
create or replace function public.verify_qr_change_otp(
  p_otp_hash text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.qr_change_otp%rowtype;
  v_name text; v_num text; v_fname text; v_fnum text; v_qr_url text;
  v_new_version integer;
begin
  if not public.is_admin() then
    raise exception 'Only administrators may change the QR configuration';
  end if;

  select * into v_row
    from public.qr_change_otp
   where admin_id = auth.uid() and consumed = false
   order by created_at desc
   limit 1
   for update;

  if not found then raise exception 'No pending QR change to verify'; end if;
  if v_row.expires_at < now() then raise exception 'The verification code has expired. Please request a new one.'; end if;
  if v_row.attempts >= 5 then raise exception 'Too many incorrect codes. Please request a new one.'; end if;

  if v_row.otp_hash <> p_otp_hash then
    update public.qr_change_otp set attempts = attempts + 1 where id = v_row.id;
    raise exception 'Incorrect verification code';
  end if;

  v_name  := btrim(coalesce(v_row.payload->>'qr_account_name', ''));
  v_num   := btrim(coalesce(v_row.payload->>'qr_account_number', ''));
  v_fname := btrim(coalesce(v_row.payload->>'fallback_receiver_name', ''));
  v_fnum  := btrim(coalesce(v_row.payload->>'fallback_receiver_number', ''));
  v_qr_url := btrim(coalesce(
    v_row.payload->>'payment_qr_url',
    v_row.payload->>'gcash_qr_url',
    v_row.payload->>'qr_photo_url',
    ''
  ));

  if v_name = '' or v_num = '' or v_fname = '' or v_fnum = '' then
    raise exception 'All fields are required';
  end if;

  update public.business_config
     set qr_account_name = v_name,
         qr_account_number = v_num,
         fallback_receiver_name = v_fname,
         fallback_receiver_number = v_fnum,
         payment_qr_url = v_qr_url,
         gcash_qr_url = v_qr_url,
         qr_photo_url = v_qr_url,
         qr_config_complete = true,
         qr_config_version = coalesce(qr_config_version, 1) + 1,
         qr_updated_at = now()
   where id = (select id from public.business_config order by id limit 1)
  returning qr_config_version into v_new_version;

  update public.qr_change_otp set consumed = true where id = v_row.id;

  insert into public.audit_logs (action_type, details, actor_name, actor_role, metadata)
  values (
    'QR_CONFIG_UPDATED',
    'Business Hub QR recipients updated (OTP verified)',
    coalesce((select full_name from public.profiles where id = auth.uid()), 'Admin'),
    'ADMIN',
    jsonb_build_object(
      'old_values', jsonb_build_object(
        'qr_account_name', v_row.payload->>'old_qr_account_name',
        'qr_account_number', v_row.payload->>'old_qr_account_number',
        'fallback_receiver_name', v_row.payload->>'old_fallback_receiver_name',
        'fallback_receiver_number', v_row.payload->>'old_fallback_receiver_number',
        'payment_qr_url', v_row.payload->>'old_payment_qr_url'
      ),
      'new_values', jsonb_build_object(
        'qr_account_name', v_name,
        'qr_account_number', v_num,
        'fallback_receiver_name', v_fname,
        'fallback_receiver_number', v_fnum,
        'payment_qr_url', v_qr_url
      ),
      'qr_config_version', v_new_version
    )
  );

  return jsonb_build_object(
    'qr_config_version', v_new_version,
    'qr_updated_at', now(),
    'payment_qr_url', v_qr_url
  );
end;
$$;

revoke all on function public.verify_qr_change_otp(text) from public;
grant execute on function public.verify_qr_change_otp(text) to authenticated;
