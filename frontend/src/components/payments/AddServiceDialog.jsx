import { useEffect, useMemo, useState } from 'react';
import toast from '@/lib/toast';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PaymentProofModal from '@/components/payments/PaymentProofModal';
import { supabase } from '@/lib/supabase';
import { BACKEND_URL } from '@/config/api';
import { getServiceCatalog } from '@/data/servicesCatalog';
import { fetchRequiredDownpayment } from '@/services/ledgerService';
import { formatPeso } from '@/features/finance/money';

// Same rule the server applies: a payment is asked for when the service costs ₱1,000 or more and the
// booking's downpayment is not yet covered (counting what is already waiting for verification).
const PAYMENT_THRESHOLD = 1000;

/**
 * Lets a customer add a service to their own open booking, using the same payment steps as the rest of
 * the app: pick the service, then pay the amount due through the shop's QR and upload the receipt
 * (read automatically, then verified by the shop). The server re-checks the price, the length of the
 * booking against the schedule, and the amount; this pop-up only guides.
 */
export default function AddServiceDialog({ open, onOpenChange, booking, vehicles = [], ledger, onAdded }) {
  const [vehicleId, setVehicleId] = useState('');
  const [service, setService] = useState(null);
  const [due, setDue] = useState(null); // { amount, needsPayment }
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

  const vehicle = vehicles.find((item) => item.id === vehicleId) || null;

  useEffect(() => {
    if (open) {
      setVehicleId(vehicles.length === 1 ? vehicles[0].id : '');
      setService(null);
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

  const choose = async (item) => {
    setService(item);
    setDue(null);
    try {
      const required = await fetchRequiredDownpayment(Number(booking.total_amount || 0) + item.price);
      const covered = Number(ledger?.verified_paid || 0) + Number(ledger?.pending_verification || 0);
      const amount = Math.min(item.price, Math.max(0, required - covered));
      setDue({ amount, needsPayment: item.price >= PAYMENT_THRESHOLD && amount > 0 });
    } catch {
      setService(null);
      toast.error('Could not work out the amount due. Please try again.');
    }
  };

  const send = async (scan) => {
    const { data: { session } } = await supabase.auth.getSession();
    const response = await fetch(`${BACKEND_URL}/api/bookings/add-service`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({
        bookingId: booking.id,
        vehicleId,
        serviceName: service.name,
        price: service.price,
        paymentType: 'Downpayment',
        ocrScanId: scan?.ocrScanId || null
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.success) throw new Error(result.error || 'The service could not be added.');
    onAdded?.(result);
    onOpenChange(false);
  };

  const addWithoutPayment = async () => {
    setBusy(true);
    try {
      await send(null);
      toast.success(`${service.name} added to your booking.`);
    } catch (error) {
      toast.error(error.message || 'The service could not be added.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog open={open && !payOpen} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
        <DialogContent className="ui-root max-h-[92dvh] gap-0 overflow-hidden p-0 sm:max-w-lg">
          <DialogHeader className="border-b px-6 py-5">
            <DialogTitle>Add a service</DialogTitle>
            <DialogDescription>Choose a service for one of your vehicles. The booking may take longer.</DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[62dvh] gap-4 overflow-y-auto px-6 py-5">
            {vehicles.length > 1 && (
              <label className="grid gap-1 text-sm font-semibold">
                Vehicle
                <select
                  className="rounded-md border bg-background px-3 py-2 text-sm font-normal"
                  value={vehicleId}
                  onChange={(event) => { setVehicleId(event.target.value); setService(null); setDue(null); }}
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
                  const selected = service?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => choose(item)}
                      aria-pressed={selected}
                      className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${selected ? 'border-primary bg-primary/10' : 'hover:bg-muted/50'}`}
                    >
                      <span className="min-w-0">
                        <span className="block font-semibold">{item.name}</span>
                        {item.estTime && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="size-3" aria-hidden="true" /> {item.estTime}</span>}
                      </span>
                      <span className="shrink-0 font-bold tabular-nums">{formatPeso(item.price)}</span>
                    </button>
                  );
                })}
              </div>
            ))}

            {service && due && (
              <div className="grid gap-1 rounded-md border bg-muted/40 px-4 py-3 text-sm">
                <div className="flex justify-between"><span>{service.name}</span><strong>{formatPeso(service.price)}</strong></div>
                <div className="flex justify-between"><span>New booking total</span><strong>{formatPeso(Number(booking.total_amount || 0) + service.price)}</strong></div>
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
              disabled={!service || !due || busy}
              onClick={() => (due.needsPayment ? setPayOpen(true) : addWithoutPayment())}
            >
              {busy ? 'Adding…' : due?.needsPayment ? 'Continue to payment' : 'Add service'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {service && due?.needsPayment && (
        <PaymentProofModal
          open={open && payOpen}
          onOpenChange={(next) => { setPayOpen(next); }}
          bookingId={booking.id}
          amountDue={due.amount}
          title={`Pay for ${service.name}`}
          description="Send the payment, then upload the receipt. The service is added once your receipt is accepted, and the shop verifies the payment."
          amountLabel="Amount to pay now"
          noun="amount due"
          showExcess={false}
          submitFn={send}
          successMessage="Service added. The shop will verify your payment and you will be notified."
        />
      )}
    </>
  );
}
