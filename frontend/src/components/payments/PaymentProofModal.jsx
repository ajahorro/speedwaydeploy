import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { CheckCircle2, ImagePlus, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import QRMagnifier from '@/components/QRMagnifier';
import { supabase } from '@/lib/supabase';
import { BACKEND_URL } from '@/config/api';
import { useConfig } from '@/context/ConfigContext';
import { useAuth } from '@/hooks/useAuth';
import { formatPeso } from '@/features/finance/money';

const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
const isImage = (file) => Boolean(file && /^image\//i.test(file.type || ''));

const TIPS = [
  'Use the receipt screen from your banking or e-wallet app, with the amount, reference number and recipient visible.',
  'Take a clear, straight, well-lit photo or a screenshot. Avoid glare and cropped edges.',
  'Pay the full balance shown above. A receipt for less cannot be accepted.',
  'Each receipt and reference number can be used once.'
];

/**
 * One pop-up for paying the remaining balance of a booking (master plan 3.10): the shop's QR, the
 * exact amount due, the receipt upload (click or drag, images only, one scan at a time), the OCR
 * result and the terms checkbox (only if the current customer terms were not accepted yet).
 *
 * The browser only helps the customer: the backend reads the receipt and the database function
 * submit_balance_payment re-derives the balance, checks the scan and creates the payment awaiting
 * admin verification. Closing the pop-up discards an unsent upload.
 */
export default function PaymentProofModal({ open, onOpenChange, bookingId, amountDue, onSubmitted }) {
  const { settings } = useConfig();
  const { profile } = useAuth();
  const [scan, setScan] = useState(null); // { state: 'scanning' | 'ready' | 'blocked', ... }
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);
  const scanCounter = useRef(0);
  const inputRef = useRef(null);

  const qrUrl = settings.qr_code_url || settings.PAYMENT_QR_URL || '';
  const needsTerms = Boolean(profile?.id)
    && Number(profile.accepted_terms_version || 0) < Number(settings.TERMS?.customer?.version || 1)
    && Boolean(settings.TERMS?.customer?.text);

  useEffect(() => {
    if (!open) {
      scanCounter.current += 1; // abandon any scan still running
      setScan(null);
      setSubmitting(false);
      setTermsChecked(false);
      setDragging(false);
    }
  }, [open]);

  const runScan = useCallback(async (file) => {
    const id = ++scanCounter.current;
    const stale = () => scanCounter.current !== id;
    setScan({ state: 'scanning', fileName: file.name });
    try {
      const form = new FormData();
      form.append('receipt', file);
      form.append('requiredAmount', String(amountDue));
      form.append('fullAmount', String(amountDue));
      form.append('paymentType', 'Full');
      form.append('rateKey', String(bookingId));
      form.append('expectedQrVersion', String(settings.QR_CONFIG_VERSION ?? ''));

      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 140000);
      let response;
      try {
        response = await fetch(`${BACKEND_URL}/api/ocr/verify-receipt`, { method: 'POST', body: form, signal: controller.signal });
      } finally {
        window.clearTimeout(timer);
      }
      const body = await response.json().catch(() => ({}));
      if (stale()) return;

      if (response.status === 429) {
        setScan({ state: 'blocked', message: `Too many scans. Please wait ${Number(body.retryAfterSeconds || 30)} seconds and try again.` });
        return;
      }
      if (response.status === 413) {
        setScan({ state: 'blocked', message: body.error || 'That image is too large. Please upload a smaller photo.' });
        return;
      }
      if (!response.ok || !body.success) throw new Error(body.error || 'The receipt service is unavailable.');

      const data = body.data || {};
      const net = Number(data.amount);
      const gross = Number(data.grossAmount);
      const fee = Number(data.transferFee) || 0;
      const manual = Boolean(body.manualReviewAllowed);
      const amountKnown = Number.isFinite(net) && data.amountDetected !== false && net > 0;

      if (body.isDuplicate) {
        setScan({ state: 'blocked', message: 'This receipt or its reference number was already used. Upload the receipt for this payment.' });
        return;
      }
      if (manual) {
        setScan({
          state: 'ready', manual: true, ocrScanId: body.ocrScanId,
          message: 'We could not read this receipt automatically. It will be sent to the shop for manual verification.'
        });
        return;
      }
      if (amountKnown && net < amountDue - 1) {
        setScan({ state: 'blocked', message: `The receipt shows ${formatPeso(net)}, but your balance is ${formatPeso(amountDue)}. Pay the full balance and upload the new receipt.` });
        return;
      }
      if (body.valid !== true) {
        const reasons = (Array.isArray(body.validationErrors) ? body.validationErrors : data.validationErrors || [])
          .map((item) => item.message).filter(Boolean);
        setScan({ state: 'blocked', message: reasons.length ? reasons.slice(0, 2).join(' ') : 'This receipt could not be accepted. Check that it is the receipt for this payment.' });
        return;
      }
      setScan({
        state: 'ready', manual: false, ocrScanId: body.ocrScanId,
        net, gross: Number.isFinite(gross) && gross > 0 ? gross : net, fee, reference: data.referenceNo,
        excess: Math.max(0, Math.round((net - amountDue) * 100) / 100)
      });
    } catch (error) {
      if (stale()) return;
      setScan({ state: 'blocked', message: error.name === 'AbortError' ? 'Reading the receipt took too long. Please try again.' : (error.message || 'The receipt could not be read. Please try again.') });
    }
  }, [amountDue, bookingId, settings.QR_CONFIG_VERSION]);

  const pick = (file) => {
    if (!file) return;
    if (scan?.state === 'scanning') return; // one scan at a time
    if (!isImage(file)) {
      toast.error('Only photos can be uploaded (JPG, PNG, WebP or HEIC).');
      return;
    }
    runScan(file);
  };

  const submit = async () => {
    if (scan?.state !== 'ready') return;
    setSubmitting(true);
    try {
      const { error } = await supabase.rpc('submit_balance_payment', { p_booking_id: bookingId, p_ocr_scan_id: scan.ocrScanId });
      if (error) throw error;
      toast.success('Payment sent. The shop will verify it and you will be notified.');
      onSubmitted?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error?.message || 'Could not send the payment. Please try again.');
      setScan({ state: 'blocked', message: error?.message || 'Could not send the payment. Please upload the receipt again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const scanning = scan?.state === 'scanning';
  const canSubmit = scan?.state === 'ready' && !submitting && (!needsTerms || termsChecked);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); }}>
      <DialogContent className="ui-root max-h-[92dvh] gap-0 overflow-hidden p-0 sm:max-w-lg" aria-busy={scanning}>
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle>Pay remaining balance</DialogTitle>
          <DialogDescription>Send the payment, then upload the receipt so the shop can verify it.</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[62dvh] gap-5 overflow-y-auto px-6 py-5">
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-4 py-3">
            <span className="text-xs font-semibold uppercase text-muted-foreground">Amount due</span>
            <span className="text-2xl font-bold tabular-nums">{formatPeso(amountDue)}</span>
          </div>

          <div className="grid gap-2">
            <p className="text-sm font-semibold">1. Pay using the shop's QR</p>
            {qrUrl ? (
              <div className="flex flex-col items-center gap-1">
                {/* The shop's configured QR, shown at full size; tap it to enlarge. */}
                <QRMagnifier
                  standalone
                  qrUrl={qrUrl}
                  accountName={settings.qr_account_name || settings.PAYMENT_ACCOUNT_NAME}
                  accountNumber={settings.qr_account_number || settings.PAYMENT_ACCOUNT_NUMBER}
                />
                <span className="text-[11px] text-muted-foreground">Tap the QR to enlarge</span>
              </div>
            ) : (
              <p role="note" className="rounded-md border px-3 py-2 text-xs text-muted-foreground">The shop's payment QR is not available right now. Use the account details below, or contact the shop.</p>
            )}
            {(settings.qr_account_name || settings.PAYMENT_ACCOUNT_NAME || settings.qr_account_number || settings.PAYMENT_ACCOUNT_NUMBER) && (
              <p className="text-xs text-muted-foreground">
                Account: <strong className="text-foreground">{settings.qr_account_name || settings.PAYMENT_ACCOUNT_NAME}</strong>
                {(settings.qr_account_number || settings.PAYMENT_ACCOUNT_NUMBER) ? <> · <span className="font-mono">{settings.qr_account_number || settings.PAYMENT_ACCOUNT_NUMBER}</span></> : null}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <p className="text-sm font-semibold">2. Upload your receipt</p>
            <label
              htmlFor="balance-receipt"
              onDragOver={(event) => { event.preventDefault(); if (!scanning) setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); pick(Array.from(event.dataTransfer?.files || []).find(isImage) || event.dataTransfer?.files?.[0]); }}
              className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors ${dragging ? 'border-primary bg-primary/10' : 'hover:bg-muted/50'} ${scanning ? 'pointer-events-none opacity-60' : ''}`}
            >
              {scanning ? <Loader2 className="size-6 animate-spin" aria-hidden="true" /> : <ImagePlus className="size-6" aria-hidden="true" />}
              <span className="text-sm font-semibold">{scanning ? 'Reading your receipt…' : 'Click to choose a photo, or drag it here'}</span>
              <span className="text-xs text-muted-foreground">JPG, PNG, WebP or HEIC · one receipt</span>
              <input
                id="balance-receipt"
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                disabled={scanning}
                onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; pick(file); }}
              />
            </label>

            {scan?.state === 'blocked' && (
              <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> <span>{scan.message}</span>
              </p>
            )}
            {scan?.state === 'ready' && (
              <div role="status" className="grid gap-1 rounded-md border border-emerald-500/50 px-3 py-2 text-sm">
                <p className="flex items-center gap-2 font-semibold text-emerald-600"><CheckCircle2 className="size-4" aria-hidden="true" /> Receipt accepted</p>
                {scan.manual ? (
                  <p className="text-muted-foreground">{scan.message}</p>
                ) : (
                  <>
                    <p>
                      Receipt shows {formatPeso(scan.gross)}
                      {scan.fee > 0 ? `, ${formatPeso(scan.net)} after fees counts toward your balance` : ' and counts toward your balance'}.
                    </p>
                    {scan.excess > 0 && <p className="text-muted-foreground">{formatPeso(scan.excess)} more than your balance is kept as credit on your account.</p>}
                  </>
                )}
              </div>
            )}
          </div>

          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-semibold">Tips for a receipt we can read</summary>
            <ul className="mt-2 grid list-disc gap-1 pl-5 text-xs text-muted-foreground">
              {TIPS.map((tip) => <li key={tip}>{tip}</li>)}
            </ul>
          </details>

          {needsTerms && (
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={termsChecked} onChange={(event) => setTermsChecked(event.target.checked)} />
              <span>I have read and agree to the terms and conditions.</span>
            </label>
          )}
        </div>

        <DialogFooter className="border-t px-6 py-4">
          <Button variant="ghost" disabled={submitting} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSubmit} title={!canSubmit && scan?.state !== 'ready' ? 'Upload a receipt first' : undefined} onClick={submit}>
            {submitting ? 'Sending…' : 'Send payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
