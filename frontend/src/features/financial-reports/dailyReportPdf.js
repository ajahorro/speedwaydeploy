import { formatPeso, formatMethod } from '@/features/finance/money';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const TZ = 'Asia/Manila';
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '');
const longDate = (day) => new Date(`${day}T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const statusWords = (status) => String(status || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
const paidWords = (status) => ({ paid: 'Fully paid', partial: 'Partly paid', unpaid: 'Not paid yet', pending: 'Waiting for verification', overpaid: 'Overpaid', refunded: 'Refunded' }[String(status || '').toLowerCase()] || statusWords(status));
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

const heading = (text) => `<h2 style="margin:18px 0 6px;font-size:14px;border-bottom:2px solid #111;padding-bottom:3px">${esc(text)}</h2>`;
const box = (label, value, note = '') => `<div style="flex:1;min-width:120px;border:1px solid #bbb;border-radius:6px;padding:8px 10px">
  <div style="font-size:9.5px;color:#555;text-transform:uppercase">${esc(label)}</div>
  <div style="font-size:16px;font-weight:700;margin-top:2px">${esc(value)}</div>
  ${note ? `<div style="font-size:9.5px;color:#555;margin-top:2px">${esc(note)}</div>` : ''}</div>`;
const th = (text, align = 'left') => `<th style="border:1px solid #bbb;background:#f1f1f1;padding:4px 6px;text-align:${align};font-size:10px">${esc(text)}</th>`;
const td = (html, align = 'left') => `<td style="border:1px solid #ccc;padding:4px 6px;text-align:${align};vertical-align:top;font-size:10.5px">${html}</td>`;
const table = (heads, rows, empty) => `<table style="width:100%;border-collapse:collapse;page-break-inside:auto">
  <thead><tr>${heads.map(([text, align]) => th(text, align)).join('')}</tr></thead>
  <tbody>${rows.length ? rows.join('') : `<tr><td colspan="${heads.length}" style="padding:8px;text-align:center;color:#666;font-size:10.5px">${esc(empty)}</td></tr>`}</tbody></table>`;

/**
 * The printable daily report, written in plain words: a short summary, the money received by method,
 * each payment, refunds, then every booking of the day (who booked it, what was booked, who works on it,
 * and what is paid and owed), then the balances still to collect. It runs over as many pages as needed.
 */
export const buildDailyReportHtml = (report) => {
  const received = report?.received || {};
  const refunds = report?.refunds || {};
  const awaiting = report?.awaiting || {};
  const totals = report?.totals || {};
  const bookings = (report?.bookings || []).filter(Boolean);
  const methods = received.by_method || [];
  const open = bookings.filter((b) => String(b.status || '').toUpperCase() !== 'CANCELLED');
  const owing = open.filter((b) => Number(b.balance) > 0.009);
  const cancelled = bookings.length - open.length;

  const methodSentence = methods.length
    ? methods.map((m) => `${formatPeso(m.total)} by ${formatMethod(m.method)}`).join(', ')
    : 'no payments';
  const summary = `On ${longDate(report.day)}, the shop received ${formatPeso(received.total)} from ${plural(received.count || 0, 'payment')} (${methodSentence}) and paid out ${formatPeso(refunds.total)} in ${plural(refunds.count || 0, 'refund')}. `
    + `${plural(open.length, 'booking')} ${open.length === 1 ? 'is' : 'are'} scheduled today${cancelled ? ` (${cancelled} cancelled)` : ''}, worth ${formatPeso(totals.total_value)}; `
    + `${formatPeso(totals.balance)} is still owed on them.`;

  const methodRows = methods.map((m) => `<tr>${td(esc(formatMethod(m.method)))}${td(String(m.count), 'right')}${td(esc(formatPeso(m.total)), 'right')}</tr>`);
  if (methods.length) methodRows.push(`<tr>${td('<strong>Total received</strong>')}${td(`<strong>${received.count || 0}</strong>`, 'right')}${td(`<strong>${esc(formatPeso(received.total))}</strong>`, 'right')}</tr>`);

  const paymentRows = (received.items || []).map((p) => `<tr>${td(esc(timeOf(p.at)))}${td(`#${esc(p.booking)}`)}${td(esc(p.customer || '—'))}${td(esc(formatMethod(p.method)))}${td(esc(p.reference || '—'))}${td(esc(formatPeso(p.amount)), 'right')}</tr>`);
  const refundRows = (refunds.items || []).map((r) => `<tr>${td(esc(timeOf(r.at)))}${td(`#${esc(r.booking)}`)}${td(esc(r.customer || '—'))}${td(esc(r.reference || '—'))}${td(esc(formatPeso(r.amount)), 'right')}</tr>`);

  const bookingBlocks = bookings.map((b) => {
    const vehicles = (b.vehicles || []).map((v) => {
      const name = [v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle';
      const services = (v.services || []).map((s) => esc(s.name)).join(', ') || 'No services listed';
      return `<div style="margin-top:3px"><strong>${esc(name)}</strong>${v.plate ? ` (${esc(v.plate)})` : ''}: ${services}${v.technician ? ` <span style="color:#555">— technician ${esc(v.technician)}</span>` : ' <span style="color:#a00">— no technician yet</span>'}</div>`;
    }).join('') || '<div style="color:#666">No vehicles listed</div>';
    const cancelledMark = String(b.status || '').toUpperCase() === 'CANCELLED';
    return `<div style="border:1px solid #bbb;border-radius:6px;padding:8px 10px;margin-bottom:8px;page-break-inside:avoid">
      <div style="display:flex;justify-content:space-between;gap:8px">
        <div><strong style="font-size:12px">${esc(timeOf(b.start_datetime))} · Booking #${esc(b.reference)}</strong></div>
        <div style="color:${cancelledMark ? '#a00' : '#333'}">${esc(statusWords(b.status))} · ${esc(paidWords(b.paid_status))}</div>
      </div>
      <div style="margin-top:3px">Booked by <strong>${esc(b.customer_name || 'Walk-in customer')}</strong>${b.contact_number ? ` · ${esc(b.contact_number)}` : ''}</div>
      ${vehicles}
      <div style="margin-top:4px;display:flex;gap:16px">
        <span>Total <strong>${esc(formatPeso(b.total))}</strong></span>
        <span>Paid <strong>${esc(formatPeso(b.paid))}</strong></span>
        <span>Owed <strong>${esc(formatPeso(b.balance))}</strong></span>
        ${Number(b.deferred) > 0 ? `<span style="color:#555">(${esc(formatPeso(b.deferred))} to be received by the shop)</span>` : ''}
      </div></div>`;
  }).join('');

  const owingRows = owing.map((b) => `<tr>${td(`#${esc(b.reference)}`)}${td(esc(b.customer_name || '—'))}${td(esc(b.contact_number || '—'))}${td(esc(statusWords(b.status)))}${td(`<strong>${esc(formatPeso(b.balance))}</strong>`, 'right')}</tr>`);

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11px;width:720px;padding:6px;line-height:1.35">
    <h1 style="margin:0;font-size:20px">Comar Garage — Daily Report</h1>
    <p style="margin:2px 0 10px;color:#444">${esc(longDate(report.day))} · printed ${esc(new Date().toLocaleString('en-PH', { timeZone: TZ }))}</p>
    <p style="margin:0 0 10px;font-size:12px">${esc(summary)}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${box('Money received', formatPeso(received.total), plural(received.count || 0, 'payment'))}
      ${box('Refunds paid', formatPeso(refunds.total), plural(refunds.count || 0, 'refund'))}
      ${box('Bookings today', String(open.length), `worth ${formatPeso(totals.total_value)}`)}
      ${box('Still owed today', formatPeso(totals.balance), 'on today\'s bookings')}
      ${box('Waiting for checking', formatPeso(awaiting.total), plural(awaiting.count || 0, 'payment') + ' to verify')}
    </div>

    ${heading('1. Money received, by method')}
    ${table([['Method'], ['Payments', 'right'], ['Amount', 'right']], methodRows, 'No money was received today.')}
    <p style="color:#666;font-size:9.5px;margin:4px 0 0">Amounts are what the shop actually received; transfer fees are not counted.</p>

    ${heading('2. Payments received')}
    ${table([['Time'], ['Booking'], ['Customer'], ['Method'], ['Reference'], ['Amount', 'right']], paymentRows, 'No payments today.')}

    ${heading('3. Refunds')}
    ${table([['Time'], ['Booking'], ['Customer'], ['Reference'], ['Amount', 'right']], refundRows, 'No refunds today.')}

    ${heading(`4. Bookings today (${bookings.length})`)}
    ${bookingBlocks || '<p style="color:#666">No bookings are scheduled today.</p>'}

    ${heading('5. Balances still to collect from today\'s bookings')}
    ${table([['Booking'], ['Customer'], ['Contact'], ['Status'], ['Owed', 'right']], owingRows, 'Nothing is owed on today\'s bookings.')}
    ${owing.length ? `<p style="margin:4px 0 0"><strong>Total owed: ${esc(formatPeso(owing.reduce((sum, b) => sum + Number(b.balance || 0), 0)))}</strong></p>` : ''}
  </div>`;
};

/** Builds the PDF in the browser (portrait A4, as many pages as needed). */
export async function downloadDailyReportPdf(report) {
  const html2pdf = (await import('html2pdf.js')).default;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
  holder.innerHTML = buildDailyReportHtml(report);
  document.body.appendChild(holder);
  try {
    await html2pdf()
      .set({
        margin: [0.4, 0.4, 0.5, 0.4],
        filename: `Comar-Garage-daily-report-${report.day}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', 'h2'] }
      })
      .from(holder.firstElementChild)
      .save();
  } finally {
    holder.remove();
  }
}
