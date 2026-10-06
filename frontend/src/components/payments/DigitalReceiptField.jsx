import { useRef, useState } from 'react';
import toast from '@/lib/toast';
import { ImagePlus } from 'lucide-react';
import { BACKEND_URL } from '@/config/api';

/**
 * Admin side of a digital payment: the receipt is read by the same OCR the customer flow uses, and the
 * amount, reference and receipt picture come from that scan. When the receipt is not accepted, or the
 * customer would rather not use it, "Enter by hand" swaps to a typed reference and amount (the parent
 * shows the amount box). A receipt that is not accepted never stores its reference number.
 *
 * Props: rateKey (booking id), maxAmount (a receipt for more is refused), reference/onReference,
 * scan/onScan (null | {state:'scanning'|'ready'|'blocked', ...}), manual/onManual, disabled.
 */
export default function DigitalReceiptField({ rateKey, maxAmount, reference, onReference, scan, onScan, manual, onManual, disabled = false, formatMoney }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const money = formatMoney || ((value) => `₱${Number(value || 0).toLocaleString()}`);

  const runScan = async (file) => {
    if (!file || busy) return;
    if (!/^image\//i.test(file.type || '')) return toast.error('Only photos can be uploaded (JPG, PNG, WebP or HEIC).');
    setBusy(true);
    onScan({ state: 'scanning' });
    try {
      const form = new FormData();
      form.append('receipt', file);
      form.append('requiredAmount', '1');
      form.append('fullAmount', String(maxAmount || 1));
      form.append('paymentType', 'Downpayment');
      form.append('rateKey', String(rateKey));
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 140000);
      let response;
      try {
        response = await fetch(`${BACKEND_URL}/api/ocr/verify-receipt`, { method: 'POST', body: form, signal: controller.signal });
      } finally {
        window.clearTimeout(timer);
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 429) return onScan({ state: 'blocked', message: `Too many scans. Wait ${Number(body.retryAfterSeconds || 30)} seconds and try again.` });
      if (!response.ok || !body.success) throw new Error(body.error || 'The receipt service is unavailable.');
      const data = body.data || {};
      const net = Number(data.amount);
      if (body.isDuplicate) return onScan({ state: 'blocked', message: 'This receipt or its reference number was already used on another payment.' });
      if (body.manualReviewAllowed || !(net > 0) || data.amountDetected === false) {
        return onScan({ state: 'blocked', message: 'The receipt could not be read.' });
      }
      if (body.valid !== true) {
        const reasons = (Array.isArray(body.validationErrors) ? body.validationErrors : data.validationErrors || []).map((item) => item.message).filter(Boolean);
        return onScan({ state: 'blocked', message: reasons.length ? reasons.slice(0, 2).join(' ') : 'This receipt could not be accepted.' });
      }
      if (maxAmount && net > Number(maxAmount) + 0.01) {
        return onScan({ state: 'blocked', message: `The receipt shows ${money(net)}, more than the ${money(maxAmount)} that is due.` });
      }
      if (data.referenceNo) onReference(String(data.referenceNo).replace(/\s+/g, ''));
      onScan({ state: 'ready', ocrScanId: body.ocrScanId, net, fee: Number(data.transferFee) || 0 });
    } catch (error) {
      onScan({ state: 'blocked', message: error.name === 'AbortError' ? 'Reading the receipt took too long. Please try again.' : (error.message || 'The receipt could not be read.') });
    } finally {
      setBusy(false);
    }
  };

  const linkButton = { background: 'transparent', border: 'none', padding: 0, color: 'var(--admin-brand)', fontWeight: 900, fontSize: '0.68rem', textDecoration: 'underline', cursor: 'pointer', alignSelf: 'flex-start' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          placeholder={manual ? 'Reference number' : 'Reference number (filled in from the receipt)'}
          aria-label="Digital transaction reference number"
          data-no-auto-capitalize="true"
          value={reference}
          readOnly={!manual && scan?.state === 'ready'}
          onChange={(event) => onReference(event.target.value.replace(/\s+/g, ''))}
          disabled={disabled}
          style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '0.85rem', background: 'var(--admin-bg)', border: '1px solid var(--admin-border)', borderRadius: '0.5rem', color: 'var(--admin-text-primary)', fontWeight: 800, outline: 'none' }}
        />
        {!manual && (
          <>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" style={{ display: 'none' }} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; runScan(file); }} />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || busy}
              title="Upload the payment receipt. It is read automatically."
              style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0 0.9rem', borderRadius: '0.5rem', border: '1px solid var(--admin-brand)', background: 'rgba(var(--admin-brand-rgb), 0.08)', color: 'var(--admin-brand)', fontWeight: 900, fontSize: '0.7rem', cursor: busy ? 'wait' : 'pointer', textTransform: 'uppercase' }}
            >
              <ImagePlus size={15} /> {busy ? 'Reading...' : (scan?.state === 'ready' ? 'Change' : 'Receipt')}
            </button>
          </>
        )}
      </div>
      {!manual && scan?.state === 'blocked' && (
        <div role="alert" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--status-danger)' }}>{scan.message}</div>
      )}
      {!manual && scan?.state === 'ready' && (
        <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--admin-text-primary)' }}>
          Read from the receipt: <span style={{ color: 'var(--status-success)' }}>{money(scan.net)}</span>
          {scan.fee > 0 ? <span style={{ color: 'var(--admin-text-secondary)' }}> (transfer fee {money(scan.fee)})</span> : null}
        </div>
      )}
      <button type="button" disabled={disabled} onClick={() => { onScan(null); onManual(!manual); }} style={linkButton}>
        {manual ? 'Use the receipt instead' : 'Receipt not accepted? Enter by hand'}
      </button>
    </div>
  );
}
