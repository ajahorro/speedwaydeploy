import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, FileText, Printer, X } from 'lucide-react';
import { resolveFrozenServicePrice } from '../data/servicesCatalog';
import { useConfig } from '../context/ConfigContext';
import {
  RECEIPT_SYSTEM_NOTICE,
  RECEIPT_TAX_NOTICE,
  RECEIPT_TITLE,
  REFUND_RECEIPT_TITLE,
  amountInWords,
  getReceiptNumber,
  isCashMethod,
  methodLabel,
  resolveInvoiceAmounts,
  resolveTransactionReceiptAmounts,
} from '../../../shared/receiptModel.ts';

/**
 * The receipt the system shows, prints and saves as PDF.
 *
 * It is an ACKNOWLEDGEMENT RECEIPT (proof that a payment was received), not an "official receipt" or a sales
 * invoice: the system is not BIR-registered, so it never shows a TIN, VAT breakdown, Authority to Print,
 * acknowledgement certificate or series range, and it says it is not valid for claim of input tax. The layout
 * follows the usual Philippine receipt: the shop at the top, the receipt number and date, cash or online, who
 * paid, what the payment was for, the totals, "received the amount of" in figures and words.
 *
 * Without `selectedPayment` it is a BOOKING SUMMARY (what the booking costs), not a receipt.
 * Pricing is flat and tax-free: the price quoted is the price charged is the price printed.
 */

const peso = (value) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 }).format(Number(value || 0));
const dateOnly = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(value)) : ''); // "Oct 21, 2026": no slashes, which the PDF converter spaces out
const dateTime = (value) => (value ? new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '');
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

/** The tick in a receipt box: two strokes drawn as a vector, so it sits exactly inside the box on screen, in print and in the PDF. */
const Cross = () => (
  <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 1 L9 9 M9 1 L1 9" stroke="#18181b" strokeWidth="1.8" strokeLinecap="square" fill="none" /></svg>
);

const PaymentReceipt = ({ booking, vehicles = [], user, selectedPayment, onClose, mode = 'modal' }) => {
  const receiptRef = useRef(null);
  const { settings } = useConfig();
  const shop = {
    name: titleCase(settings?.BUSINESS_NAME || 'Comar Garage'),
    address: settings?.BUSINESS_ADDRESS || '',
    phone: settings?.BUSINESS_CONTACT_NUMBER || '',
    email: settings?.BUSINESS_EMAIL || '',
  };
  const effectiveVehicles = vehicles.length ? vehicles : (booking?.vehicles || []);

  const isRefund = Boolean(selectedPayment)
    && String(selectedPayment.method || '').toUpperCase() === 'SYSTEM_REFUND'
    && Number(selectedPayment.amount) < 0;
  const isReceipt = Boolean(selectedPayment);
  const pay = isReceipt && !isRefund ? resolveTransactionReceiptAmounts(selectedPayment) : null;
  const refundAmount = isRefund ? Math.abs(Number(selectedPayment.amount) || 0) : 0;
  const invoice = resolveInvoiceAmounts(booking || {});
  const promoName = booking?.promo_name_snapshot || null;

  // Payments made before this one (when the booking's payments are on hand), so the receipt can show the balance.
  const allPayments = Array.isArray(booking?.payments) ? booking.payments : null;
  const counted = (p) => String(p?.status || '').toUpperCase() === 'PAID' && String(p?.method || '').toUpperCase() !== 'SYSTEM_REFUND';
  const paidBefore = allPayments && pay
    ? allPayments
      .filter((p) => counted(p) && p.id !== selectedPayment.id && new Date(p.created_at || 0) < new Date(selectedPayment.created_at || 0))
      .reduce((sum, p) => { const a = resolveTransactionReceiptAmounts(p); return sum + a.netReceived + a.creditApplied; }, 0)
    : null;
  const thisPayment = pay ? pay.netReceived + pay.creditApplied : 0;
  // Booking summary: once payments are recorded it shows how the booking was paid and what is left.
  const paidList = !isReceipt && allPayments ? allPayments.filter(counted) : [];
  const paidTotal = paidList.reduce((sum, p) => { const a = resolveTransactionReceiptAmounts(p); return sum + a.netReceived + a.creditApplied; }, 0);
  const paidMethods = [...new Set(paidList.map((p) => String(p.method || '').toUpperCase()).filter(Boolean))];
  const summaryBalance = Math.max(0, invoice.totalDue - paidTotal);
  const balanceAfter = paidBefore === null ? null : Math.max(0, invoice.totalDue - paidBefore - thisPayment);

  const customerName = booking?.customer_name || booking?.customer?.full_name || user?.user_metadata?.full_name || '';
  const customerEmail = booking?.customer_email || booking?.customer?.email || user?.email || '';
  const customerPhone = booking?.contact_number || booking?.customer?.contact_number || '';
  const bookingNo = String(booking?.id || '').slice(0, 8).toUpperCase();

  const title = isRefund ? REFUND_RECEIPT_TITLE : (isReceipt ? RECEIPT_TITLE : 'BOOKING SUMMARY');
  // Receipt numbers are digits only and in order (payments.receipt_no). A booking summary is not a receipt, so it has none.
  const number = isReceipt ? getReceiptNumber(selectedPayment) : null;
  const docDate = isReceipt ? (selectedPayment.verified_at || selectedPayment.created_at) : booking?.created_at;
  const method = isReceipt ? selectedPayment.method : booking?.payment_method;
  const cash = isCashMethod(method);
  const reference = isReceipt ? (selectedPayment.reference_number || selectedPayment.detected_ref || '') : '';
  const received = isRefund ? refundAmount : thisPayment;

  const items = effectiveVehicles.flatMap((vehicle) => (vehicle.services || []).map((service, index) => {
    const price = resolveFrozenServicePrice(service);
    const car = [vehicle.brand, vehicle.model].filter(Boolean).join(' ');
    return {
      key: service.id || `${vehicle.id}-${index}`,
      description: `${service.service_name || service.service_name_snapshot || 'Service'}${car ? ` (${car}${vehicle.plate_number ? `, ${vehicle.plate_number}` : ''})` : ''}`,
      price,
    };
  }));
  if (!items.length) items.push({ key: 'booking', description: booking?.service_package || 'Car care services', price: invoice.subtotal });

  const downloadPdf = async () => {
    if (!receiptRef.current) return;
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      html2pdf().set({ margin: 0.4, filename: `${shop.name.replace(/\s+/g, '-')}-${number || `booking-${bookingNo}`}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' } }).from(receiptRef.current).save();
    } catch {
      window.print();
    }
  };

  const content = (
    <div ref={receiptRef} id="printable-receipt" className="ar-doc" translate="no">
      <style>{`
        .ar-doc{background:#fff;color:#18181b;padding:clamp(16px,4vw,32px);font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;font-size:13px;line-height:1.45}
        .ar-doc *{box-sizing:border-box;border-radius:0 !important}
        .ar-doc table{border-collapse:collapse !important;border-spacing:0 !important}
        .ar-top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:16px}
        .ar-shop{min-width:0;flex:1 1 260px}
        .ar-shopname{font-size:22px;font-weight:800;letter-spacing:-.01em;margin:0}
        .ar-muted{color:#5f5b57}
        .ar-doctitle{color:#C41F2B;font-size:18px;font-weight:800;letter-spacing:.02em;margin:0;text-align:right}
        .ar-meta{flex:0 1 auto;display:grid;gap:6px;justify-items:end}
        .ar-box{border:1px solid #18181b}
        .ar-kv{display:grid;grid-template-columns:auto 1fr}
        .ar-kv>div{padding:5px 10px;border-bottom:1px solid #d6d3cf}
        .ar-kv>div:nth-last-child(-n+2){border-bottom:0}
        .ar-kv>.k{border-right:1px solid #d6d3cf;color:#5f5b57;white-space:nowrap}
        .ar-checks{display:flex;flex-wrap:wrap;gap:20px;margin:16px 0 10px;font-weight:600}
        .ar-check{display:inline-flex;align-items:center;gap:8px}
        .ar-check i{display:block;flex:none;width:16px;height:16px;border:1.5px solid #18181b;padding:2px}
        .ar-check i svg{display:block;width:100%;height:100%}
        .ar-section{margin-top:12px}
        .ar-label{background:#f3f1ee;padding:6px 10px;font-weight:700;font-size:11px;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid #18181b}
        .ar-scroll{overflow-x:auto}
        .ar-table{width:100%;border-collapse:collapse;min-width:440px}
        .ar-table th,.ar-table td{border:1px solid #18181b;padding:7px 10px;vertical-align:top}
        .ar-table th{background:#f3f1ee;font-size:11px;letter-spacing:.04em;text-transform:uppercase;text-align:center}
        .ar-num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
        .ar-two{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;align-items:start}
        @media (max-width:560px){.ar-two{grid-template-columns:1fr}.ar-meta{justify-items:start}.ar-doctitle{text-align:left}}
        .ar-total>div{font-weight:800;font-size:14px}
        .ar-received{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin-top:18px}
        .ar-line{flex:1 1 200px;border-bottom:1px solid #18181b;padding:0 6px 2px;font-weight:800;font-size:15px}
        .ar-words{margin-top:4px;font-style:italic}
        .ar-foot{margin-top:28px;padding-top:10px;border-top:1px solid #d6d3cf;display:grid;gap:4px;font-size:11px}
        .ar-tax{font-weight:800;letter-spacing:.02em;color:#18181b}
      `}</style>

      <div className="ar-top">
        <div className="ar-shop">
          <p className="ar-shopname">{shop.name}</p>
          {shop.address && <div className="ar-muted">{shop.address}</div>}
          {(shop.phone || shop.email) && <div className="ar-muted">{[shop.phone, shop.email].filter(Boolean).join(' · ')}</div>}
          <div className="ar-muted">comargarage.com</div>
        </div>
        <div className="ar-meta">
          <p className="ar-doctitle">{title}</p>
          {number && <div><span className="ar-muted">Receipt no.</span> <strong style={{ color: '#C41F2B' }}>{number}</strong></div>}
          <div className="ar-box ar-kv" style={{ minWidth: 200 }}>
            <div className="k">Date</div><div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{dateOnly(docDate) || '—'}</div>
          </div>
        </div>
      </div>

      <div className="ar-checks" role="group" aria-label="Payment type">
        <span className="ar-check"><i aria-hidden="true">{(isReceipt ? cash : paidMethods.some(isCashMethod)) ? <Cross /> : null}</i>CASH</span>
        <span className="ar-check"><i aria-hidden="true">{(isReceipt ? !cash : paidMethods.some((m) => !isCashMethod(m))) ? <Cross /> : null}</i>ONLINE{isReceipt
          ? (!cash && method ? ` (${methodLabel(method)})` : '')
          : (paidMethods.some((m) => !isCashMethod(m)) ? ` (${paidMethods.filter((m) => !isCashMethod(m)).map(methodLabel).join(', ')})` : '')}</span>
      </div>

      <div className="ar-box">
        <div className="ar-label">{isRefund ? 'Refunded to' : isReceipt ? 'Received from' : 'Customer'}</div>
        <div className="ar-kv">
          <div className="k">Name</div><div>{customerName || '—'}</div>
          <div className="k">Contact</div><div style={{ overflowWrap: 'anywhere' }}>{[customerPhone, customerEmail].filter(Boolean).join(' · ') || '—'}</div>
          <div className="k">Booking no.</div><div>{bookingNo || '—'}{booking?.start_datetime ? ` · appointment ${dateTime(booking.start_datetime)}` : ''}</div>
        </div>
      </div>

      <div className="ar-section ar-scroll">
        <table className="ar-table">
          <thead><tr><th style={{ width: '58%' }}>Description / Nature of service</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}><td>{item.description}</td><td className="ar-num" style={{ textAlign: 'center' }}>1</td><td className="ar-num">{peso(item.price)}</td><td className="ar-num">{peso(item.price)}</td></tr>
            ))}
            {invoice.discount > 0 && (
              <tr><td>Less: discount{promoName ? ` (${promoName})` : ''}</td><td /><td /><td className="ar-num">−{peso(invoice.discount)}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="ar-two">
        <div className="ar-box">
          <div className="ar-label">Payment details</div>
          <div className="ar-kv">
            <div className="k">Paid by</div><div>{isReceipt ? (cash ? 'Cash' : methodLabel(method)) : paidMethods.length ? paidMethods.map((m) => (isCashMethod(m) ? 'Cash' : methodLabel(m))).join(', ') : 'Not paid yet'}</div>
            {!isReceipt && paidList.length > 0 && <><div className="k">Status</div><div style={{ fontWeight: 700 }}>{summaryBalance === 0 ? 'Fully paid' : 'Partly paid'}</div></>}
            {!isReceipt && paidList.length > 0 && <><div className="k">Last payment</div><div>{dateTime(paidList[paidList.length - 1].verified_at || paidList[paidList.length - 1].created_at) || '—'}</div></>}
            {isReceipt && <><div className="k">Reference no.</div><div style={{ overflowWrap: 'anywhere' }}>{reference || (cash ? 'Paid at the shop' : 'Not provided')}</div></>}
            {isReceipt && <><div className="k">Recorded</div><div>{dateTime(selectedPayment.verified_at || selectedPayment.created_at) || '—'}</div></>}
            {pay && pay.transferFee > 0 && <><div className="k">Transfer fee</div><div className="ar-num" style={{ textAlign: 'left' }}>{peso(pay.transferFee)} (charged by the payment app, not by the shop)</div></>}
          </div>
        </div>
        <div className="ar-box">
          <div className="ar-label">Summary</div>
          <div className="ar-kv">
            <div className="k">Booking total</div><div className="ar-num">{peso(invoice.subtotal)}</div>
            {invoice.discount > 0 && <><div className="k">Less: discount</div><div className="ar-num">−{peso(invoice.discount)}</div></>}
            <div className="k">Amount due</div><div className="ar-num">{peso(invoice.totalDue)}</div>
            {pay && paidBefore !== null && <><div className="k">Paid before this</div><div className="ar-num">{peso(paidBefore)}</div></>}
            {pay && pay.creditApplied > 0 && <><div className="k">Account credit used</div><div className="ar-num">{peso(pay.creditApplied)}</div></>}
            {isReceipt && <><div className="k" style={{ fontWeight: 800, color: '#18181b' }}>{isRefund ? 'Amount refunded' : 'This payment'}</div><div className="ar-num" style={{ fontWeight: 800 }}>{peso(received)}</div></>}
            {balanceAfter !== null && <><div className="k">Balance remaining</div><div className="ar-num">{peso(balanceAfter)}</div></>}
            {!isReceipt && paidList.length > 0 && <><div className="k">Amount paid</div><div className="ar-num">{peso(paidTotal)}</div></>}
            {!isReceipt && paidList.length > 0 && <><div className="k" style={{ fontWeight: 800, color: '#18181b' }}>Balance remaining</div><div className="ar-num" style={{ fontWeight: 800 }}>{peso(summaryBalance)}</div></>}
          </div>
        </div>
      </div>

      {isReceipt && (
        <div>
          <div className="ar-received">
            <span className="ar-check"><i aria-hidden="true"><Cross /></i>{isRefund ? 'Refunded the amount of' : 'Received the amount of'}</span>
            <span className="ar-line ar-num" style={{ textAlign: 'center' }}>{peso(received)}</span>
          </div>
          <div className="ar-words ar-muted">{amountInWords(received)}</div>
        </div>
      )}

      <div className="ar-foot ar-muted">
        <span className="ar-tax">{RECEIPT_TAX_NOTICE}</span>
        <span>{isReceipt ? RECEIPT_SYSTEM_NOTICE : 'Booking summary only. This is not a receipt or a sales invoice.'}</span>
        <span>Generated by the {shop.name} booking system (comargarage.com) on {dateTime(new Date())}.</span>
      </div>
    </div>
  );

  if (mode === 'page') return content;
  const modalTitle = isRefund ? 'Refund acknowledgement' : isReceipt ? 'Acknowledgement receipt' : 'Booking summary';
  return (
    <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
      <div role="dialog" aria-modal="true" aria-label={modalTitle} style={{ width: '100%', maxWidth: '800px', maxHeight: '92dvh', overflow: 'auto', background: '#fff', borderRadius: 4 }}>
        <div className="no-print" style={{ position: 'sticky', top: 0, zIndex: 1, background: '#111214', color: '#fff', padding: '0.75rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 700, fontSize: '0.85rem' }}><FileText size={18} /> {modalTitle}</span>
          {onClose && <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 0, color: '#fff', cursor: 'pointer', minHeight: 0 }}><X size={18} /></button>}
        </div>
        {content}
        {createPortal(
          <div className="ar-print-root">
            <style>{`.ar-print-root{display:none}@media print{body>*:not(.ar-print-root){display:none !important}.ar-print-root{display:block !important;position:static !important}.ar-print-root #printable-receipt{position:static !important;visibility:visible !important}.ar-print-root *{visibility:visible !important}}`}</style>
            {React.cloneElement(content, { ref: undefined })}
          </div>,
          document.body
        )}
        <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem', padding: '0.8rem 1rem', background: '#f6f5f3', borderTop: '1px solid #e7e4e0' }}>
          <button type="button" onClick={downloadPdf} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#C41F2B', color: '#fff', border: 0, borderRadius: 2, cursor: 'pointer', fontWeight: 600 }}><Download size={15} /> Download PDF</button>
          <button type="button" onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#fff', color: '#18181b', border: '1px solid #d6d3cf', borderRadius: 2, cursor: 'pointer', fontWeight: 600 }}><Printer size={15} /> Print</button>
        </div>
      </div>
    </div>
  );
};

export default PaymentReceipt;
