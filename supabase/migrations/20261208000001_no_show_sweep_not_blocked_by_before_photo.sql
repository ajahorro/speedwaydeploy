-- The no-show sweep must never be stopped by a single booking.
--
-- Found on the live site: a booking whose technician had uploaded a before photo, but never pressed Start, stayed
-- "Confirmed" days after its scheduled time. Flagging a no-show clears the booking's technician in the same update,
-- and the rule that locks a technician in once they have uploaded a before photo looked only at the OLD status, so it
-- refused the change. One refused row made the whole sweep fail, every five minutes, so no booking was flagged or
-- cancelled for anyone.
--
-- 1. The lock now lets a booking move into no-show, cancelled, completed or released (the technician is still
--    remembered in no_show_staff_id, as before).
-- 2. The sweep handles each booking on its own: if one cannot be processed it is skipped, an audit entry says why
--    (once every six hours per booking), and every other booking is still processed.

create or replace function public.prevent_staff_reassignment_after_before_evidence()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.staff_id is not null
     and old.staff_id is distinct from new.staff_id
     and lower(coalesce(old.status::text, '')) not in ('completed', 'released', 'cancelled', 'flagged_noshow', 'no_show')
     and lower(coalesce(new.status::text, '')) not in ('completed', 'released', 'cancelled', 'flagged_noshow', 'no_show')
     and exists (
       select 1
         from public.service_photos photo
        where photo.booking_id = old.id
          and photo.phase = 'before'
          and photo.uploaded_by = old.staff_id
          and photo.archived_at is null
     )
  then
    raise exception 'STAFF_REASSIGNMENT_LOCKED_AFTER_BEFORE_PHOTO'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- An audit entry for a booking the sweep could not process (not repeated more than once every six hours).
create or replace function public.record_no_show_sweep_failure(p_booking_id uuid, p_step text, p_message text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_logs (booking_id, action_type, actor_name, actor_role, details)
  select p_booking_id, 'NO_SHOW_SWEEP_FAILED', 'System', 'SYSTEM',
         format('Booking #%s could not be %s by the automatic check: %s', upper(left(p_booking_id::text, 8)), p_step, p_message)
   where not exists (
     select 1 from public.audit_logs a
      where a.action_type = 'NO_SHOW_SWEEP_FAILED'
        and a.booking_id = p_booking_id
        and a.created_at > now() - interval '6 hours'
   );
$$;
revoke all on function public.record_no_show_sweep_failure(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_no_show_sweep_failure(uuid, text, text) to service_role;

create or replace function public.flag_no_show_bookings(p_grace interval default interval '1 hour', p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := p_now - p_grace;
  v_count integer := 0;
  r record;
begin
  for r in
    select id
      from public.bookings
     where status in ('scheduled', 'confirmed')
       and start_datetime is not null
       and start_datetime <= v_cutoff
     order by start_datetime
  loop
    begin
      update public.bookings b
         set status = 'FLAGGED_NOSHOW',
             -- Never claim attention: a no-show has its own container.
             needs_attention = false,
             staff_id = null,
             bay_id = null,
             refund_status = coalesce(b.refund_status, 'QUEUED'),
             updated_at = p_now
       where b.id = r.id
         -- A booking that was started (or cancelled) in the meantime is left alone.
         and b.status in ('scheduled', 'confirmed');
      if found then v_count := v_count + 1; end if;
    exception when others then
      perform public.record_no_show_sweep_failure(r.id, 'flagged as a no-show', sqlerrm);
    end;
  end loop;

  if v_count > 0 then
    -- Payments on a no-show become refundable. A FOR_VERIFICATION claim is queued too, because the customer
    -- may well have paid and the money needs a decision either way.
    update public.payments
       set status = 'REFUND_PENDING'
     where booking_id in (select id from public.bookings where status = 'FLAGGED_NOSHOW')
       and status in ('PAID', 'FOR_VERIFICATION');
  end if;

  return v_count;
end;
$$;

create or replace function public.close_expired_no_show_windows(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    select id
      from public.bookings
     where status = 'FLAGGED_NOSHOW'
       and start_datetime is not null
       and public.no_show_phase(status, start_datetime, p_now) = 'UNDO_WINDOW_CLOSED'
  loop
    begin
      update public.bookings b
         set status = 'cancelled',
             needs_attention = false,
             staff_id = null,
             bay_id = null,
             -- Preserve a queued refund; stamp the reason so the books explain themselves.
             refund_status = coalesce(b.refund_status, 'QUEUED'),
             cancellation_reason = coalesce(
               nullif(btrim(coalesce(b.cancellation_reason, '')), ''),
               'Automatically cancelled 24 hours after being flagged as a no-show.'
             ),
             updated_at = p_now
       where b.id = r.id
         and b.status = 'FLAGGED_NOSHOW';
      if found then v_count := v_count + 1; end if;
    exception when others then
      perform public.record_no_show_sweep_failure(r.id, 'cancelled', sqlerrm);
    end;
  end loop;

  return v_count;
end;
$$;
