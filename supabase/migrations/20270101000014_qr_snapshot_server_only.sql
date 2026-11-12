-- A new booking's QR snapshot always comes from the shop's own settings, never from the client.
-- (Receipts are accepted if they match the booking's snapshot, so a client-written snapshot would let someone name their own account.)

create or replace function public.default_qr_snapshot()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cfg jsonb;
begin
  select jsonb_build_object(
           'qr_account_name', qr_account_name,
           'qr_account_number', qr_account_number,
           'payment_qr_url', coalesce(payment_qr_url, gcash_qr_url, qr_photo_url),
           'gcash_qr_url', coalesce(gcash_qr_url, payment_qr_url, qr_photo_url),
           'qr_photo_url', coalesce(qr_photo_url, payment_qr_url, gcash_qr_url),
           'qr_config_version', coalesce(qr_config_version, 1),
           'captured_at', now()
         )
    into v_cfg from public.business_config order by id limit 1;
  if v_cfg is not null then
    new.active_qr_snapshot := v_cfg;
    new.qr_snapshot_version := coalesce((v_cfg ->> 'qr_config_version')::integer, 1);
  end if;
  return new;
end $$;
