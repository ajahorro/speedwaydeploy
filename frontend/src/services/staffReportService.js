import { supabase } from '@/lib/supabase';

/**
 * Staff reports: the whole shop's bookings for a date range, with no money and no contact details.
 * The database function checks that an administrator turned reports on for this account.
 * `range` is { from: Date, to: Date } with `to` exclusive (the same shape the admin reports use).
 */
export const fetchStaffBookingsReport = async ({ from, to }) => {
  const { data, error } = await supabase.rpc('staff_bookings_report', {
    p_from: from.toISOString(),
    p_to: to.toISOString()
  });
  if (error) throw error;
  return data;
};
