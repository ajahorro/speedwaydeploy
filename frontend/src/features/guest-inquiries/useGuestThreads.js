import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { subscribeTable } from '@/lib/realtimeHub';

/** The website visitors' conversations, shaped like the account conversations so one list can show both. */
export function useGuestThreads() {
  const [threads, setThreads] = useState([]);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_guest_inquiry_threads');
    if (error) return;
    setThreads((data || []).map((row) => ({
      customer_id: `guest:${row.inquiry_id}`,
      inquiry_id: row.inquiry_id,
      isGuest: true,
      customer_name: row.name,
      customer_email: row.email,
      last_message: row.last_message,
      last_message_type: 'text',
      last_message_at: row.last_message_at,
      unread_count: row.unread_count,
      booking_ids: []
    })));
  }, []);

  useEffect(() => {
    refresh();
    return subscribeTable({ table: 'guest_inquiry_messages' }, refresh);
  }, [refresh]);

  return { guestThreads: threads, refreshGuestThreads: refresh };
}
