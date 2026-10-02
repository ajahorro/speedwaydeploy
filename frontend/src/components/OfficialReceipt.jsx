import React, { useRef } from 'react';
import { Download, Printer, ShieldCheck, X } from 'lucide-react';
import { resolveFrozenServicePrice } from '../data/servicesCatalog';

const currency = (value) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
}).format(Number(value || 0));

const dateValue = (value) => value
  ? new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
  : '-';

/** Money rounding. Matches round2() in utils/paymentAmounts.js. */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const OfficialReceipt = ({ booking, vehicles = [], user, selectedPayment, onClose, mode = 'modal', title }) => {
  const receiptRef = useRef(null);
  const effectiveVehicles = vehicles.length ? vehicles : (booking?.vehicles || []);

  // ── PRICING MODEL: FLAT AND TAX-FREE ─────────────────────────────────────
  //
  // This system applies NO VAT and no percentage-based tax of any kind. The
  // figure quoted is the figure charged is the figure stored is the figure
  // printed here:
  //
  //     Total Amount Due = the item / package price, exactly
  //
  // There is no division by 1.12 and no "Vatable Sales" / "VAT (12%)" line.
  //
  // HISTORY, so this is not reintroduced: the receipt previously derived a 12%
  // VAT split from the total, and before that it ADDED 12% on top — which made a
  // ₱2,500 booking print a "Total Amount Due" of ₱2,800, a figure the customer
  // was never charged and which existed nowhere in the database. Both models are
  // now removed rather than reconciled. A tax figure computed in more than one
  // place is a tax figure that will eventually disagree with itself.
  const bookingTotal = Number(booking?.total_amount ?? 0);
  const paymentReceived = selectedPayment ? Number(selectedPayment.amount || 0) : 0;
  // A payment receipt accounts for one transaction, not the booking's full
  // invoice. Mixing the two made a partial payment receipt show (for example)
  // ₱1,090 received against a ₱250 total due.
  const gross = selectedPayment ? paymentReceived : bookingTotal;
  // The promo/discount snapshot is frozen on the BOOKING at creation time (the
  // payments table has no discount column). Prefer the payment's own value when a
  // caller supplies one, otherwise read the booking snapshot so a discounted
  // booking shows a real "Discount / Promo" line instead of ₱0.
  const discount = Number(
    selectedPayment?.discount_amount ?? booking?.discount_amount_snapshot ?? 0
  ) || 0;
  const promoName = booking?.promo_name_snapshot || null;
  // The discount was already applied when the total was computed at booking time
  // (booking.total_amount is POST-discount), so it is shown for transparency but
  // is NOT subtracted again here — doing so would double-count it.
  //
  // Flat, tax-free: the total IS the price. No tax base, no tax line, no division.
  const total = round2(gross);
  const isNoShow = ['FLAGGED_NOSHOW', 'NO_SHOW'].includes(String(booking?.status || '').toUpperCase());
  const refundStatus = String(booking?.refund_status || '').trim();
  const totalLabel = selectedPayment ? 'Payment Received' : 'Total Amount Due';

  const customerName = booking?.customer?.full_name || booking?.customer_name || user?.user_metadata?.full_name || 'Valued Customer';
  const customerEmail = booking?.customer?.email || booking?.customer_email || user?.email || '';
  const documentTitle = title || (selectedPayment ? 'OFFICIAL RECEIPT' : 'INVOICE');
  const reference = selectedPayment?.reference_number || `INV-${(booking?.id || 'RECEIPT').slice(0, 8).toUpperCase()}`;

  const downloadPdf = async () => {
    if (!receiptRef.current) return;
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      html2pdf().set({ margin: 0.5, filename: `Comar-Garage-${reference}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' } }).from(receiptRef.current).save();
    } catch {
      window.print();
    }
  };

  const rows = selectedPayment
    ? [{ description: 'Payment for Booking', price: paymentReceived }]
    : effectiveVehicles.flatMap((vehicle) => (vehicle.services || []).map((service, index) => ({
      key: service.id || `${vehicle.id}-${index}`,
      description: `${vehicle.brand || ''} ${vehicle.model || ''} - ${service.service_name || service.service_name_snapshot || 'Service'}`,
      price: resolveFrozenServicePrice(service),
    })));
  if (!rows.length) rows.push({ description: booking?.service_package || 'Professional Auto Detail & Care Package', price: total });

  const content = (
    <div ref={receiptRef} id="printable-receipt" style={{ background: '#fff', color: '#111827', padding: '2rem', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '2rem', borderBottom: '2px solid #111827', paddingBottom: '1.25rem' }}>
        <div><div style={{ fontSize: '1.8rem', fontWeight: 900, fontStyle: 'italic' }}>COMAR GARAGE</div><div style={{ color: '#6B7280', fontSize: '0.75rem', letterSpacing: '1px', textTransform: 'uppercase' }}>Auto Detailing Studio</div><div style={{ color: '#6B7280', fontSize: '0.75rem', marginTop: '0.75rem' }}>123 Comar Garage Drive, Quezon City, Metro Manila</div></div>
        <div style={{ textAlign: 'right' }}><div style={{ color: '#E61E2A', fontWeight: 900, fontSize: '0.75rem' }}>{documentTitle}</div><div style={{ fontWeight: 800, marginTop: '0.5rem' }}>{reference}</div><div style={{ color: '#6B7280', fontSize: '0.75rem', marginTop: '0.35rem' }}>{dateValue(selectedPayment?.created_at || booking?.created_at)}</div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', margin: '1.5rem 0' }}>
        <div><strong style={{ display: 'block', fontSize: '0.65rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Billed To</strong><div style={{ marginTop: '0.35rem', fontWeight: 700 }}>{customerName}</div><div style={{ color: '#6B7280', fontSize: '0.8rem' }}>{customerEmail}</div></div>
        <div><strong style={{ display: 'block', fontSize: '0.65rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Work Order</strong><div style={{ marginTop: '0.35rem', fontWeight: 700 }}>WO-{(booking?.id || 'REF').slice(0, 12).toUpperCase()}</div><div style={{ color: '#6B7280', fontSize: '0.8rem' }}>{selectedPayment?.method || 'Digital / Online Payment'}</div></div>
      </div>
      {isNoShow && (
        <div role="status" style={{ margin: '0 0 1.25rem', padding: '0.85rem 1rem', border: '1px solid #FCA5A5', borderRadius: '4px', background: '#FEF2F2', color: '#991B1B', fontSize: '0.8rem', lineHeight: 1.5 }}>
          <strong style={{ display: 'block', textTransform: 'uppercase' }}>Booking flagged as no-show</strong>
          <span>
            {refundStatus
              ? `Refund status: ${refundStatus.replace(/_/g, ' ')}.`
              : 'This receipt records the payment only; check the Refund Hub for refund eligibility and updates.'}
          </span>
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}><thead><tr>{['Description', 'Qty', 'Unit Price', 'Total'].map((heading, index) => <th key={heading} style={{ textAlign: index ? 'right' : 'left', padding: '0.65rem 0.4rem', borderBottom: '2px solid #E5E7EB', color: '#6B7280', textTransform: 'uppercase', fontSize: '0.65rem' }}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.key || index}><td style={{ padding: '0.8rem 0.4rem', borderBottom: '1px solid #F3F4F6' }}>{row.description}</td><td style={{ textAlign: 'right' }}>1</td><td style={{ textAlign: 'right' }}>{currency(row.price)}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{currency(row.price)}</td></tr>)}</tbody></table>
      <div style={{ width: '280px', margin: '1.5rem 0 0 auto', borderTop: '2px solid #111827', paddingTop: '0.75rem' }}><div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem' }}><span>{selectedPayment ? 'Payment Subtotal' : 'Subtotal'}</span><span>{currency(gross)}</span></div>{!selectedPayment && discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem', marginTop: '0.4rem' }}><span>Discount / Promo{promoName ? ` (${promoName})` : ''}</span><span>-{currency(discount)}</span></div>}<div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: '1.1rem', marginTop: '0.7rem' }}><span>{totalLabel}</span><span>{currency(total)}</span></div></div>
    </div>
  );

  if (mode === 'page') return content;
  return <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}><div style={{ width: '100%', maxWidth: '760px', maxHeight: '92vh', overflow: 'auto', background: '#fff', borderRadius: '6px' }}><div className="no-print" style={{ background: '#111827', color: '#fff', padding: '0.8rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, fontSize: '0.8rem' }}><ShieldCheck size={18} /> Official Receipt</span>{onClose && <button onClick={onClose} aria-label="Close receipt" style={{ background: 'transparent', border: 0, color: '#fff', cursor: 'pointer' }}><X size={18} /></button>}</div>{content}<div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '0.8rem 1rem', background: '#F9FAFB' }}><button onClick={downloadPdf} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#111827', color: '#fff', border: 0, cursor: 'pointer' }}><Download size={15} /> Download PDF</button><button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#E5E7EB', color: '#111827', border: 0, cursor: 'pointer' }}><Printer size={15} /> Print</button></div></div></div>;
};

export default OfficialReceipt;
