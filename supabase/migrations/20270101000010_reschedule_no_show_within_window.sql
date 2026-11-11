-- A no-show can be rescheduled while its 24-hour window is still open, without undoing the no-show first.
-- Rescheduling it does what "undo no-show" does (booking back to scheduled, payments held for refund go back to
-- paid, the refund the no-show queued is dropped) and moves it to the new time. Refused once the window closes or
-- after money was already returned.
do $$
declare
  v_def text := pg_get_functiondef('public.reschedule_booking(uuid,timestamptz,timestamptz,text)'::regprocedure);
  v_new text;
  pairs text[][] := array[
    [ 'v_violation       text;',
      'v_violation       text;
  v_from_no_show    boolean := false;' ],
    [ 'if lower(v_booking.status) not in (''scheduled'', ''confirmed'') then',
      'v_from_no_show := upper(coalesce(v_booking.status, '''')) in (''FLAGGED_NOSHOW'', ''NO_SHOW'');
  if v_from_no_show then
    if public.no_show_phase(v_booking.status, v_booking.start_datetime, now()) <> ''UNDO_WINDOW_OPEN'' then
      raise exception ''The 24-hour window to reschedule this missed appointment has closed.'';
    end if;
    if exists (select 1 from public.payments
                where booking_id = p_booking_id
                  and (upper(coalesce(status, '''')) in (''REFUNDED'', ''REFUND_PROCESSED'', ''RELEASED'')
                       or (upper(coalesce(method, '''')) = ''SYSTEM_REFUND'' and coalesce(amount, 0) < 0))) then
      raise exception ''This booking was already refunded, so it cannot be rescheduled. Please make a new booking.'';
    end if;
    -- Back to scheduled first (a no-show''s time is locked); this also brings back its technician.
    -- If anything below fails, the whole reschedule is undone and it stays a no-show.
    update public.bookings set status = ''scheduled'', updated_at = now() where id = p_booking_id;
    select * into v_booking from public.bookings where id = p_booking_id;
  elsif lower(v_booking.status) not in (''scheduled'', ''confirmed'') then' ],
    [ 'v_prior_status := lower(v_booking.status);',
      'v_prior_status := case when v_from_no_show then ''scheduled'' else lower(v_booking.status) end;' ],
    [ 'reminder_sent = false,',
      'reminder_sent = false,
         refund_status = case when v_from_no_show and upper(coalesce(v_booking.refund_status, '''')) = ''QUEUED'' then null else refund_status end,
         cancellation_reason = case when v_from_no_show then null else cancellation_reason end,' ],
    [ '-- Reset vehicle scheduling markers only for units that have NOT started.',
      'if v_from_no_show then
    update public.payments set status = ''PAID''
     where booking_id = p_booking_id and upper(coalesce(status, '''')) = ''REFUND_PENDING'';
  end if;

  -- Reset vehicle scheduling markers only for units that have NOT started.' ],
    [ '''prior_status'', v_prior_status',
      '''prior_status'', v_prior_status,
      ''from_no_show'', v_from_no_show' ]
  ];
  i int;
begin
  if position('v_from_no_show' in v_def) > 0 then return; end if;
  v_new := v_def;
  for i in 1 .. array_length(pairs, 1) loop
    if (length(v_new) - length(replace(v_new, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 then
      raise exception 'reschedule_booking changed; this migration needs updating (%)', pairs[i][1];
    end if;
    v_new := replace(v_new, pairs[i][1], pairs[i][2]);
  end loop;
  execute v_new;
end $$;
