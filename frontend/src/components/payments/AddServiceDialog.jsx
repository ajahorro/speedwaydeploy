import { useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { Check, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PaymentProofModal from '@/components/payments/PaymentProofModal';
import { supabase } from '@/lib/supabase';
import { BACKEND_URL } from '@/config/api';
import { getServiceCatalog } from '@/data/servicesCatalog';
import { fetchRequiredDownpayment } from '@/services/ledgerService';
import { formatPeso } from '@/features/finance/money';

// Same rule the server applies: a payment is asked for when the services cost ₱1,000 or more together and the
// booking's downpayment is not yet covered (counting what is already waiting for verification).
const PAYMENT_THRESHOLD = 1000;

/**
 * Lets a customer add one or more services to their own open booking, using the same payment steps as the rest of
 * the app: tick the services, then pay the amount due for all of them through the shop's QR and upload the receipt
 * (read automatically, then verified by the shop). One payment covers the combined price. The server re-checks
 * every price, the length of the booking against the schedule, and the amount; either all the services are added
 * or none. This pop-up only guides.
 */
export default function AddServiceDialog({ open, onOpenChange, booking, vehicles = [], ledger, onAdded }) {
  const [vehicleId, setVehicleId] = useState('');
  const [selected, setSelected] = useState([]); // chosen services, in the order they were ticked
  const [due, setDue] = useState(null); // { amount, needsPayment } for the whole selection
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

  const vehicle = vehicles.find((item) => item.id === vehicleId) || null;
  const subtotal = selected.reduce((sum, item) => sum + item.price, 0);
  const label = selected.length === 1 ? selected[0].name : `${selected.length} services`;

  useEffect(() => {
    if (open) {
      setVehicleId(vehicles.length === 1 ? vehicles[0].id : '');
      setSelected([]);
      setDue(null);
      setBusy(false);
      setPayOpen(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => {
    if (!vehicle) return [];
    const taken = new Set((vehicle.services || []).map((item) => String(item.service_name || item.name || '').toLowerCase()));
    return Object.entries(getServiceCatalog())
      .map(([category, items]) => [category, items
        .map((item) => ({ ...item, price: Number(item.prices?.[vehicle.vehicle_type] || 0) }))
        .filter((item) => item.price > 0 && !taken.has(String(item.name).toLowerCase()))])
      .filter(([, items]) => items.length > 0);
  }, [vehicle]);

  const toggle = (item) => {
    setSelected((current) => (current.some((entry) => entry.id === item.id)
      ? current.filter((entry) => entry.id !== item.id)
      : [...current, item]));
  };

  // What has to be paid now for the whole selection (the same arithmetic the server uses).
  useEffect(() => {
    if (selected.length === 0) { setDue(null); return undefined; }
    let alive = true;
    setDue(null);
    (async () => {
      try {
        const required = await fetchRequiredDownpayment(Number(booking.total_amount || 0) + subtotal);
        const covered = Number(ledger?.verified_paid || 0) + Number(ledger?.pending_verification || 0);
        const amount = Math.min(subtotal, Math.max(0, required - covered));
        if (alive) setDue({ amount, needsPayment: subtotal >= PAYMENT_THRESHOLD && amount > 0 });
      } catch {
        if (alive) {
          setSelected([]);
          toast.error('Could not work out the amount due. Please try again.');
        }
      }
    })();
    return () => { alive = false; };
  }, [selected, subtotal]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (scan) => {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`${BACKEND_URL}/api/bookings/add-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({
        bookingId: booking.id,
        services: selected.map((item) => ({ vehicleId, serviceName: item.name, price: item.price })),
        paymentType: 'Downpayment',
        ocrScanId: scan?.ocrScanId || null
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'The services could not be added.');
    onAdded?.(result);
    onOpenChange(false);
  };

  const addWithoutPayment = async () => {
    setBusy(true);
    try {
      await send(null);
      toast.success(selected.length === 1 ? `${selected[0].name} added to your booking.` : `${selected.length} services added to your booking.`);
    } catch (error) {
      toast.error(error.message || 'The services could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open && !payOpen} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
        <DialogContent className="ui-root max-h-[92dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>Add services</DialogTitle>
            <DialogDescription>Choose one or more services for one of your vehicles. The booking may take longer.</DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[62dvh] gap-4 overflow-y-auto px-6 py-5">
            {vehicles.length > 1 && (
              <label className="grid gap-1 text-sm font-semibold">
                Vehicle
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                  value={vehicleId}
                  onChange={(event) => { setVehicleId(event.target.value); setSelected([]); setDue(null); }}
                >
                  <option value="">Choose a vehicle…</option>
                  {vehicles.map((item) => <option key={item.id} value={item.id}>{`${item.brand || ''} ${item.model || ''}`.trim() || item.plate_number} · {item.plate_number}</option>)}
                </select>
              </label>
            )}

            {vehicle && options.length === 0 && <p className="text-sm text-muted-foreground">No more services are available for this vehicle.</p>}
            {vehicle && options.map(([category, items]) => (
              <div key={category} className="grid gap-2">
                <p className="text-xs font-semibold uppercase text-muted-foreground">{category}</p>
                {items.map((item) => {
                  const isSelected = selected.some((entry) => entry.id === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggle(item)}
                      role="checkbox"
                      aria-checked={isSelected}
                      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${isSelected ? 'border-primary bg-primary/10' : 'hover:bg-muted/50'}`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className={`flex size-5 shrink-0 items-center justify-center rounded-sm border ${isSelected ? 'border-primary bg-primary text-primary-foreground' : ''}`} aria-hidden="true">
                          {isSelected && <Check className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-semibold">{item.name}</span>
                          {item.estTime && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" aria-hidden="true" /> {item.estTime}</span>}
                        </span>
                      </span>
                      <span className="shrink-0 font-bold tabular-nums">{formatPeso(item.price)}</span>
                    </button>
                  );
                })}
              </div>
            ))}

            {selected.length > 0 && due && (
              <div className="grid gap-1 rounded-md border bg-muted/40 px-4 py-3 text-sm">
                {selected.map((item) => (
                  <div key={item.id} className="flex justify-between gap-3"><span className="min-w-0">{item.name}</span><strong className="shrink-0">{formatPeso(item.price)}</strong></div>
                ))}
                {selected.length > 1 && <div className="flex justify-between border-t pt-1"><span>Services total</span><strong>{formatPeso(subtotal)}</strong></div>}
                <div className="flex justify-between"><span>New booking total</span><strong>{formatPeso(Number(booking.total_amount || 0) + subtotal)}</strong></div>
                <div className="flex justify-between">
                  <span>To pay now</span>
                  <strong>{due.needsPayment ? formatPeso(due.amount) : 'Nothing yet'}</strong>
                </div>
                {!due.needsPayment && <p className="text-xs text-muted-foreground">The rest is paid later, like the rest of your balance.</p>}
              </div>
            )}
          </div>

          <DialogFooter className="border-t px-6 py-4">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              disabled={selected.length === 0 || !due || busy}
              onClick={() => (due.needsPayment ? setPayOpen(true) : addWithoutPayment())}
            >
              {busy ? 'Adding…' : due?.needsPayment ? 'Continue to payment' : selected.length > 1 ? `Add ${selected.length} services` : 'Add service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selected.length > 0 && due?.needsPayment && (
        <PaymentProofModal
          open={open && payOpen}
          onOpenChange={(next) => { setPayOpen(next); }}
          bookingId={booking.id}
          amountDue={due.amount}
          title={`Pay for ${label}`}
          description="Send the payment, then upload the receipt. The services are added once your receipt is accepted, and the shop verifies the payment."
          amountLabel="Amount to pay now"
          noun="amount due"
          showExcess={false}
          submitFn={send}
          successMessage={selected.length > 1 ? 'Services added. The shop will verify your payment and you will be notified.' : 'Service added. The shop will verify your payment and you will be notified.'}
        />
      )}
    </>
  );
}
