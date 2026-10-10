import { useEffect, useMemo, useState } from 'react';
import { fetchRefundProofs, refundProofKey } from '../services/refundProofService';

/**
 * Proofs of refund for these bookings. `proofFor(payment)` returns the proof of a refund record (or null), so a ledger
 * row can show its "Proof of refund" button. `refreshKey` reloads them (e.g. after a realtime payment change).
 */
export function useRefundProofs(bookingIds, refreshKey = 0) {
  const [proofs, setProofs] = useState(() => new Map());
  const idsKey = useMemo(() => [...new Set((bookingIds || []).filter(Boolean))].sort().join(','), [bookingIds]);

  useEffect(() => {
    let cancelled = false;
    if (!idsKey) { setProofs(new Map()); return undefined; }
    fetchRefundProofs(idsKey.split(',')).then((map) => { if (!cancelled) setProofs(map); });
    return () => { cancelled = true; };
  }, [idsKey, refreshKey]);

  const proofFor = (payment) => (payment ? proofs.get(refundProofKey(payment.booking_id, payment.reference_number)) || null : null);
  return { proofs, proofFor };
}
