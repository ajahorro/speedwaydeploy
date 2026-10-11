-- Undoing a no-show checked "has this booking already been refunded?" without locking the booking row. A refund that
-- committed between that check and the status update left a reinstated (scheduled) booking whose money had already been
-- returned: a debt with no payment behind it. The undo now takes the booking row lock first (as the refund and cancel
-- functions do), so it waits for any refund in progress and then sees it.

do $patch$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.undo_no_show(uuid,text,boolean)'::regprocedure) into v_def;
  if v_def not like '%select * into v_booking from public.bookings where id = p_booking_id for update%' then
    v_new := replace(
      v_def,
      E'select * into v_booking from public.bookings where id = p_booking_id;',
      E'select * into v_booking from public.bookings where id = p_booking_id for update;'
    );
    if v_new = v_def then raise exception 'undo_no_show layout changed; patch not applied'; end if;
    execute v_new;
  end if;
end
$patch$;
