import React, { useRef } from 'react';
import { Download, Printer, ShieldCheck, X } from 'lucide-react';

const currency = (value) => new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 2,
}).format(Number(value || 0));

const dateValue = (value) => value
  ? new Date(value).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' })
  : '-';

const VAT_RATE = 0.12;

const OfficialReceipt = ({ booking, vehicles = [], user, selectedPayment, onClose, mode = 'modal', title }) => {
  const receiptRef = useRef(null);
  const effectiveVehicles = vehicles.length ? vehicles : (booking?.vehicles || []);

  // Unified tax model — must match buildReceiptEmailHtml / buildReceiptPdfBuffer
  // in backend/server.js so the on-screen and emailed receipts agree:
  //   vatable = subtotal - discount;  VAT = vatable * 12%;  total = vatable + VAT
  const subtotal = selectedPayment
    ? Number(selectedPayment.amount || 0)
    : Number(booking?.total_amount ?? 0);
  const discount = Number(selectedPayment?.discount_amount || 0);
  const vatableSales = Math.max(0, subtotal - discount);
  const vat = Math.max(0, vatableSales * VAT_RATE);
  const total = vatableSales + vat;

  const customerName = booking?.customer?.full_name || booking?.customer_name || user?.user_metadata?.full_name || 'Valued Customer';
  const customerEmail = booking?.customer?.email || booking?.customer_email || user?.email || '';
  const documentTitle = title || (selectedPayment ? 'OFFICIAL RECEIPT' : 'INVOICE');
  const reference = selectedPayment?.reference_number || `INV-${(booking?.id || 'RECEIPT').slice(0, 8).toUpperCase()}`;

  const downloadPdf = async () => {
    if (!receiptRef.current) return;
    try {
      const html2pdf = (await import('html2pdf.js')).default;
      html2pdf().set({ margin: 0.5, filename: `Speedway-${reference}.pdf`, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' } }).from(receiptRef.current).save();
    } catch {
      window.print();
    }
  };

  const rows = selectedPayment
    ? [{ description: 'Service Installment / Settlement Payment', price: total }]
    : effectiveVehicles.flatMap((vehicle) => (vehicle.services || []).map((service, index) => ({
      key: service.id || `${vehicle.id}-${index}`,
      description: `${vehicle.brand || ''} ${vehicle.model || ''} - ${service.service_name || service.service_name_snapshot || 'Service'}`,
      price: Number(service.price || service.price_snapshot || 0),
    })));
  if (!rows.length) rows.push({ description: booking?.service_package || 'Professional Auto Detail & Care Package', price: total });

  const content = (
    <div ref={receiptRef} id="printable-receipt" style={{ background: '#fff', color: '#111827', padding: '2rem', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '2rem', borderBottom: '2px solid #111827', paddingBottom: '1.25rem' }}>
        <div><div style={{ fontSize: '1.8rem', fontWeight: 900, fontStyle: 'italic' }}>SPEED<span style={{ color: '#E61E2A' }}>WAY</span></div><div style={{ color: '#6B7280', fontSize: '0.75rem', letterSpacing: '1px', textTransform: 'uppercase' }}>AutoXMoto Detail Studio</div><div style={{ color: '#6B7280', fontSize: '0.75rem', marginTop: '0.75rem' }}>123 Speedway Drive, Quezon City, Metro Manila</div></div>
        <div style={{ textAlign: 'right' }}><div style={{ color: '#E61E2A', fontWeight: 900, fontSize: '0.75rem' }}>{documentTitle}</div><div style={{ fontWeight: 800, marginTop: '0.5rem' }}>{reference}</div><div style={{ color: '#6B7280', fontSize: '0.75rem', marginTop: '0.35rem' }}>{dateValue(selectedPayment?.created_at || booking?.created_at)}</div></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem', margin: '1.5rem 0' }}>
        <div><strong style={{ display: 'block', fontSize: '0.65rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Billed To</strong><div style={{ marginTop: '0.35rem', fontWeight: 700 }}>{customerName}</div><div style={{ color: '#6B7280', fontSize: '0.8rem' }}>{customerEmail}</div></div>
        <div><strong style={{ display: 'block', fontSize: '0.65rem', color: '#9CA3AF', textTransform: 'uppercase' }}>Work Order</strong><div style={{ marginTop: '0.35rem', fontWeight: 700 }}>WO-{(booking?.id || 'REF').slice(0, 12).toUpperCase()}</div><div style={{ color: '#6B7280', fontSize: '0.8rem' }}>{selectedPayment?.method || 'Digital / Online Payment'}</div></div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}><thead><tr>{['Description', 'Qty', 'Unit Price', 'Total'].map((heading, index) => <th key={heading} style={{ textAlign: index ? 'right' : 'left', padding: '0.65rem 0.4rem', borderBottom: '2px solid #E5E7EB', color: '#6B7280', textTransform: 'uppercase', fontSize: '0.65rem' }}>{heading}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={row.key || index}><td style={{ padding: '0.8rem 0.4rem', borderBottom: '1px solid #F3F4F6' }}>{row.description}</td><td style={{ textAlign: 'right' }}>1</td><td style={{ textAlign: 'right' }}>{currency(row.price)}</td><td style={{ textAlign: 'right', fontWeight: 700 }}>{currency(row.price)}</td></tr>)}</tbody></table>
      <div style={{ width: '280px', margin: '1.5rem 0 0 auto', borderTop: '2px solid #111827', paddingTop: '0.75rem' }}><div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem' }}><span>Subtotal</span><span>{currency(subtotal)}</span></div>{discount > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem', marginTop: '0.4rem' }}><span>Discount / Promo</span><span>-{currency(discount)}</span></div>}<div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem', marginTop: '0.4rem' }}><span>Vatable Sales</span><span>{currency(vatableSales)}</span></div><div style={{ display: 'flex', justifyContent: 'space-between', color: '#6B7280', fontSize: '0.8rem', marginTop: '0.4rem' }}><span>VAT (12%)</span><span>{currency(vat)}</span></div><div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 900, fontSize: '1.1rem', marginTop: '0.7rem' }}><span>Total Amount Due</span><span>{currency(total)}</span></div></div>
    </div>
  );

  if (mode === 'page') return content;
  return <div className="modal-overlay" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}><div style={{ width: '100%', maxWidth: '760px', maxHeight: '92vh', overflow: 'auto', background: '#fff', borderRadius: '6px' }}><div className="no-print" style={{ background: '#111827', color: '#fff', padding: '0.8rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800, fontSize: '0.8rem' }}><ShieldCheck size={18} /> Official Receipt</span>{onClose && <button onClick={onClose} aria-label="Close receipt" style={{ background: 'transparent', border: 0, color: '#fff', cursor: 'pointer' }}><X size={18} /></button>}</div>{content}<div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '0.8rem 1rem', background: '#F9FAFB' }}><button onClick={downloadPdf} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#111827', color: '#fff', border: 0, cursor: 'pointer' }}><Download size={15} /> Download PDF</button><button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.6rem 0.9rem', background: '#E5E7EB', color: '#111827', border: 0, cursor: 'pointer' }}><Printer size={15} /> Print</button></div></div></div>;
};

export default OfficialReceipt;
