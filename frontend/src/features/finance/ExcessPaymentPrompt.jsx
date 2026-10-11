import { Button } from '@/components/ui/button';
import { formatPeso } from '@/features/finance/money';

/**
 * Shown on top of the financial ledger (not the whole screen) when a customer has paid more than the booking costs:
 * ask for the excess back, or put it toward another service. "Decide later" closes it until the page is opened again.
 */
export default function ExcessPaymentPrompt({ amount, canAddService, busy, onRefund, onAddService, onDismiss }) {
  return (
    <div
      role="dialog"
      aria-label="You paid more than the booking costs"
      className="ui-root absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-background/70 p-4 backdrop-blur-[2px]"
    >
      <div className="grid w-full max-w-sm gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-lg">
        <div>
          <p className="text-sm font-bold">You paid {formatPeso(amount)} more than this booking costs.</p>
          <p className="mt-1 text-sm text-muted-foreground">Do you want the excess refunded, or would you like to add another service?</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" onClick={onRefund} disabled={busy}>{busy ? 'Sending…' : 'Refund the excess'}</Button>
          <Button type="button" variant="outline" onClick={onAddService} disabled={busy || !canAddService} title={canAddService ? undefined : 'Services cannot be added to this booking anymore.'}>Add a new service</Button>
        </div>
        <button type="button" onClick={onDismiss} disabled={busy} className="text-xs font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground">Decide later</button>
      </div>
    </div>
  );
}
