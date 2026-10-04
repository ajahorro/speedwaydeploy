import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PAID_STATUS_LABELS } from './money';

const TONE = {
  paid: 'bg-success/15 text-success',
  overpaid: 'bg-chart-2/15 text-chart-2',
  partial: 'bg-warning/15 text-warning',
  pending: 'bg-warning/15 text-warning',
  partially_refunded: 'bg-chart-2/15 text-chart-2',
  refunded: 'bg-muted text-muted-foreground',
  unpaid: 'bg-destructive/15 text-destructive',
  void: 'bg-muted text-muted-foreground',
  // payment row statuses
  PAID: 'bg-success/15 text-success',
  FOR_VERIFICATION: 'bg-warning/15 text-warning',
  REFUND_PENDING: 'bg-chart-2/15 text-chart-2',
  REFUNDED: 'bg-muted text-muted-foreground',
  REJECTED: 'bg-destructive/15 text-destructive'
};

const ROW_LABELS = {
  PAID: 'Paid',
  FOR_VERIFICATION: 'For verification',
  REFUND_PENDING: 'Refund pending',
  REFUNDED: 'Refunded',
  REJECTED: 'Rejected'
};

/** Badge for a ledger paid_status or a payment row status. */
export function PaymentStatusBadge({ status, className }) {
  const label = PAID_STATUS_LABELS[status] || ROW_LABELS[status] || String(status || 'Unknown');
  return (
    <Badge variant="secondary" className={cn('rounded-sm border-0 font-semibold', TONE[status], className)}>
      {label}
    </Badge>
  );
}
