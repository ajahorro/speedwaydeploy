import React, { useState } from 'react';
import { Zap } from 'lucide-react';
import toast from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { supabase } from '../../lib/supabase';
import { useConfirmAction } from '../../hooks/useConfirmAction';

/**
 * "Customer arrived early": lets service (before photo, then start) begin before the scheduled time, on the booking's day.
 * The allowance is made by the database function allow_early_start(), which also checks who is asking and writes the
 * booking history. Shown only while the scheduled time is still ahead and no early start has been allowed.
 */
const EarlyStartButton = ({ bookingId, onAllowed, className = '' }) => {
  const { confirmThen } = useConfirmAction();
  const [busy, setBusy] = useState(false);

  const allow = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.rpc('allow_early_start', { p_booking_id: bookingId });
      if (error) throw error;
      toast.success('Early start allowed. Service can begin now.');
      await onAllowed?.();
    } catch (err) {
      toast.error(err?.message || 'Could not allow an early start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      className={className}
      onClick={() => confirmThen({
        title: 'Customer arrived early?',
        message: 'Service can then start before the scheduled time today. This is recorded in the booking history.',
        confirmText: 'Allow early start'
      }, allow)}
    >
      <Zap /> Customer is here early
    </Button>
  );
};

export default EarlyStartButton;
