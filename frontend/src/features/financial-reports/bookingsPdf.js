import { formatPeso, formatMethod } from '@/features/finance/money';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const label = (status) => String(status || '').replace(/_/g, ' ').toUpperCase();

/** The printable document for the bookings of a date range, with the money behind each one. */
export const buildBookingsReportHtml = ({ report, rangeLabel }) => {
  const totals = report?.totals || {};
  const rows = report?.bookings || [];
  const body = rows.map((b) => {
    const vehicles = (b.vehicles || []).map((v) => {
      const services = (v.services || []).map((s) => esc(s.name)).join(', ');
      return `<div><strong>${esc([v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle')}</strong> ${v.plate ? `(${esc(v.plate)})` : ''}${services ? `<br><span style="color:#555">${services}</span>` : ''}</div>`;
    }).join('') || '<span style="color:#888">No vehicles listed</span>';
    const methods = (b.methods || []).map(formatMethod).join(', ');
    return `<tr>
      <td>${esc(when(b.start_datetime))}</td>
      <td style="font-family:monospace">#${esc(b.reference)}</td>
      <td><strong>${esc(b.customer_name)}</strong>${b.contact_number ? `<br><span style="color:#555">${esc(b.contact_number)}</span>` : ''}${b.technician ? `<br><span style="color:#555">Tech: ${esc(b.technician)}</span>` : ''}</td>
      <td>${vehicles}</td>
      <td>${esc(label(b.status))}<br><span style="color:#555">${esc(label(b.paid_status))}</span></td>
      <td style="text-align:right">${esc(formatPeso(b.total))}</td>
      <td style="text-align:right">${esc(formatPeso(b.paid))}${methods ? `<br><span style="color:#555">${esc(methods)}</span>` : ''}</td>
      <td style="text-align:right"><strong>${esc(formatPeso(b.balance))}</strong>${Number(b.deferred) > 0 ? `<br><span style="color:#555">to be received ${esc(formatPeso(b.deferred))}</span>` : ''}${Number(b.pending_verification) > 0 ? `<br><span style="color:#555">awaiting verification ${esc(formatPeso(b.pending_verification))}</span>` : ''}</td>
    </tr>`;
  }).join('');

  const stat = (name, value) => `<div style="flex:1;min-width:130px;border:1px solid #ccc;border-radius:6px;padding:8px 10px"><div style="font-size:10px;color:#666;text-transform:uppercase">${esc(name)}</div><div style="font-size:16px;font-weight:700">${esc(value)}</div></div>`;

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11px;width:1020px;padding:8px">
    <h1 style="margin:0 0 2px;font-size:20px">Comar Garage — Bookings report</h1>
    <p style="margin:0 0 12px;color:#444">${esc(rangeLabel)} · generated ${esc(new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${stat('Bookings', `${totals.count ?? 0} (${totals.active_count ?? 0} active)`)}
      ${stat('Booking value', formatPeso(totals.total_value))}
      ${stat('Received (net)', formatPeso(totals.paid))}
      ${stat('Refunded', formatPeso(totals.refunded))}
      ${stat('Balance owed', formatPeso(totals.balance))}
      ${stat('To be received', formatPeso(totals.deferred))}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px">
      <thead><tr style="background:#f1f1f1">
        ${['Start', 'Ref', 'Customer', 'Vehicles and services', 'Status', 'Total', 'Paid', 'Balance'].map((h, i) => `<th style="border:1px solid #ccc;padding:5px;text-align:${i >= 5 ? 'right' : 'left'}">${h}</th>`).join('')}
      </tr></thead>
      <tbody>${body || '<tr><td colspan="8" style="padding:14px;text-align:center;color:#666">No bookings in this range.</td></tr>'}</tbody>
    </table>
    <p style="margin-top:10px;color:#666;font-size:9.5px">Amounts come from the shop's payment ledger. "Paid" is the money received, "to be received" is a balance an administrator deferred, not money received.</p>
  </div>`;
};

/** Builds the PDF in the browser (the PDF library loads only when this runs). */
export async function downloadBookingsPdf({ report, rangeLabel, fileLabel }) {
  const html2pdf = (await import('html2pdf.js')).default;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
  holder.innerHTML = buildBookingsReportHtml({ report, rangeLabel });
  document.body.appendChild(holder);
  try {
    await html2pdf()
      .set({
        margin: 0.35,
        filename: `Comar-Garage-bookings-${fileLabel || 'report'}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' },
        pagebreak: { mode: ['css', 'legacy'], avoid: 'tr' }
      })
      .from(holder.firstElementChild)
      .save();
  } finally {
    holder.remove();
  }
}
