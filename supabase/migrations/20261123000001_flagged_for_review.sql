-- ============================================================================
-- "Flagged for review": ONE definition, used by the dashboard card and by the Booking Management filter.
--
-- The dashboard card counted every rejected payment ROW (including the retired "to be received" record, which is
-- marked rejected once the balance is paid, and rejected receipts that were already replaced), while its link opened
-- the no-show filter. So a fully paid booking showed as "flagged" and the link showed something else.
--
-- A booking is flagged for review when it is still open (not cancelled or flagged as a no-show, which have their
-- own cards) and either
--   * its latest real payment was rejected and nothing has replaced it, while money is still owed on the booking;
--     (the system's own records, the "to be received" marker and refund entries, are not real payments), or
--   * somebody marked it as needing attention.
-- One row per booking, with the reason. Administrators only.
-- ============================================================================
create or replace function public.flagged_bookings_for_review()
returns table (booking_id uuid, reason text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;

  return query
  with open_bookings as (
    select b.id, b.needs_attention
      from public.bookings b
     where lower(coalesce(b.status::text, '')) not in ('cancelled', 'flagged_noshow', 'no_show')
  ),
  real_payments as (
    select p.booking_id, p.status, p.created_at
      from public.payments p
     where upper(coalesce(p.method, '')) not in ('RECEIVABLE', 'SYSTEM_REFUND')
  ),
  rejected_unreplaced as (
    select r.booking_id
      from real_payments r
     where upper(r.status::text) = 'REJECTED'
       and not exists (
         select 1 from real_payments later
          where later.booking_id = r.booking_id
            and later.created_at > r.created_at
            and upper(later.status::text) in ('PAID', 'FOR_VERIFICATION')
       )
     group by r.booking_id
  )
  select o.id,
         case when ru.booking_id is not null and coalesce(l.outstanding_amount, 0) > 0.009 then 'Payment rejected'
              else 'Marked for attention' end
    from open_bookings o
    left join rejected_unreplaced ru on ru.booking_id = o.id
    left join public.booking_ledger_v l on l.booking_id = o.id
   where (ru.booking_id is not null and coalesce(l.outstanding_amount, 0) > 0.009)
      or coalesce(o.needs_attention, false);
end;
$fn$;

revoke all on function public.flagged_bookings_for_review() from public, anon;
grant execute on function public.flagged_bookings_for_review() to authenticated;
