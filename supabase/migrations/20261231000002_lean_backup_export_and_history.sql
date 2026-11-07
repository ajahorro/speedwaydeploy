-- 1. Backup export, fast: one aggregate instead of re-copying the growing result per table (that was quadratic),
--    and the payment-QR image copies left out of the change-history snapshots (each booking keeps its own copy).
-- 2. Change history (audit_trails) stops copying bookings.active_qr_snapshot, a ~270 KB image, on every change.
--    It doubled the history on each booking update (41 MB from 12 bookings) and would fill the free database.
--    Rows already written are left as they are.

create or replace function public.backup_table_rows(p_table text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare rows jsonb;
begin
  if p_table = 'audit_trails' then
    select coalesce(jsonb_agg(to_jsonb(x) || jsonb_build_object(
             'old_data', x.old_data - 'active_qr_snapshot', 'new_data', x.new_data - 'active_qr_snapshot')), '[]')
      into rows from public.audit_trails x;
  else
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x', p_table) into rows;
  end if;
  return rows;
end $$;

create or replace function public.export_system_backup()
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('format', 'comar-backup-v1', 'created_at', now(),
           'tables', coalesce(jsonb_object_agg(c.relname, public.backup_table_rows(c.relname)), '{}'))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname <> all (public.backup_excluded_tables())
$$;

revoke all on function public.backup_table_rows(text) from public, anon, authenticated;
revoke all on function public.export_system_backup() from public, anon, authenticated;
grant execute on function public.export_system_backup() to service_role;

create or replace function public.process_audit_log()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  current_user_id uuid := auth.uid();
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_booking_id uuid := case
    when tg_table_name = 'bookings' then (v_row ->> 'id')::uuid
    else nullif(v_row ->> 'booking_id', '')::uuid
  end;
  -- the booking's payment-QR image is not history: it is kept on the booking itself
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) - 'active_qr_snapshot' end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) - 'active_qr_snapshot' end;
begin
  -- A booking being deleted takes its history with it: do not write a copy
  -- for the booking itself or for rows cascading from it.
  if tg_op = 'DELETE'
     and v_booking_id is not null
     and not exists (select 1 from public.bookings where id = v_booking_id) then
    return old;
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_trails (table_name, record_id, action_type, old_data, actor_id, booking_id)
    values (tg_table_name, old.id, 'DELETE', v_old, current_user_id, v_booking_id);
    return old;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_trails (table_name, record_id, action_type, old_data, new_data, actor_id, booking_id)
    values (tg_table_name, new.id, 'UPDATE', v_old, v_new, current_user_id, v_booking_id);
    return new;
  elsif tg_op = 'INSERT' then
    insert into public.audit_trails (table_name, record_id, action_type, new_data, actor_id, booking_id)
    values (tg_table_name, new.id, 'INSERT', v_new, current_user_id, v_booking_id);
    return new;
  end if;
  return null;
end;
$function$;
