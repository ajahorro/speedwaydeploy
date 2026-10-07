const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

export const statusGroup = (status) => {
  const key = String(status || '').toLowerCase();
  if (['cancelled', 'flagged_noshow', 'no_show'].includes(key)) return 'cancelled';
  if (key === 'in_progress') return 'in_progress';
  if (['completed', 'released'].includes(key)) return 'completed';
  return 'upcoming';
};

/** Plain words for a booking status. */
export const statusWords = (status) => {
  const key = String(status || '').toLowerCase();
  if (['cancelled'].includes(key)) return 'Cancelled';
  if (['flagged_noshow', 'no_show'].includes(key)) return 'No-show';
  if (key === 'in_progress') return 'In progress';
  if (key === 'released') return 'Finished';
  if (key === 'completed') return 'Completed';
  if (key === 'confirmed') return 'Confirmed';
  return 'Scheduled';
};

const vehicleLine = (v) => [[v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle', v.plate ? `(${v.plate})` : ''].filter(Boolean).join(' ');

const csvCell = (value) => {
  const text = String(value ?? '');
  // a leading = + - @ would be run as a formula by a spreadsheet
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Downloads the bookings of the report as a CSV (no money, no contact details). */
export const downloadStaffBookingsCsv = ({ report, fileLabel }) => {
  const rows = [['Start', 'Reference', 'Customer', 'Status', 'Walk-in', 'Vehicle', 'Plate', 'Services', 'Technician']];
  (report?.bookings || []).forEach((b) => {
    const vehicles = b.vehicles?.length ? b.vehicles : [{}];
    vehicles.forEach((v) => rows.push([
      when(b.start), b.reference, b.customer, statusWords(b.status), b.walk_in ? 'Yes' : 'No',
      [v.brand, v.model].filter(Boolean).join(' '), v.plate || '', (v.services || []).join('; '), v.technician || ''
    ]));
  });
  const blob = new Blob(['﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `Comar-Garage-bookings-${fileLabel || 'report'}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};

/** The printable document: the bookings of the range with their vehicles, services and technicians. */
export const buildStaffBookingsHtml = ({ report, rangeLabel }) => {
  const t = report?.totals || {};
  const body = (report?.bookings || []).map((b) => `<tr>
      <td>${esc(when(b.start))}<br><span style="font-family:monospace;color:#555">#${esc(b.reference)}</span></td>
      <td><strong>${esc(b.customer)}</strong>${b.walk_in ? '<br><span style="color:#555">Walk-in</span>' : ''}</td>
      <td>${(b.vehicles || []).map((v) => `<div><strong>${esc(vehicleLine(v))}</strong>${(v.services || []).length ? `<br><span style="color:#555">${esc(v.services.join(', '))}</span>` : ''}${v.technician ? `<br><span style="color:#555">Technician: ${esc(v.technician)}</span>` : ''}</div>`).join('') || '—'}</td>
      <td>${esc(statusWords(b.status))}</td>
    </tr>`).join('');
  const stat = (name, value) => `<div style="flex:1;min-width:110px;border:1px solid #ccc;border-radius:6px;padding:8px 10px"><div style="font-size:10px;color:#666;text-transform:uppercase">${esc(name)}</div><div style="font-size:16px;font-weight:700">${esc(value)}</div></div>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:11px;width:1000px;padding:8px">
    <h1 style="margin:0 0 2px;font-size:20px">Comar Garage — Bookings report</h1>
    <p style="margin:0 0 12px;color:#444">${esc(rangeLabel)} · generated ${esc(new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${stat('Bookings', t.bookings ?? 0)}${stat('Vehicles', t.vehicles ?? 0)}${stat('Upcoming', t.upcoming ?? 0)}${stat('In progress', t.in_progress ?? 0)}${stat('Finished', t.completed ?? 0)}${stat('Cancelled', t.cancelled ?? 0)}
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:10.5px">
      <thead><tr style="background:#f1f1f1">${['Start', 'Customer', 'Vehicles, services and technician', 'Status'].map((h) => `<th style="border:1px solid #ccc;padding:5px;text-align:left">${h}</th>`).join('')}</tr></thead>
      <tbody>${body || '<tr><td colspan="4" style="padding:14px;text-align:center;color:#666">No bookings in this range.</td></tr>'}</tbody>
    </table>
    <p style="margin-top:10px;color:#666;font-size:9.5px">This report shows bookings only. Payments, prices, and contact details are not included.</p>
  </div>`.replace(/<td>/g, '<td style="border:1px solid #ccc;padding:5px;vertical-align:top">');
};

/** Builds the PDF in the browser (the PDF library loads only when this runs). */
export async function downloadStaffBookingsPdf({ report, rangeLabel, fileLabel }) {
  const html2pdf = (await import('html2pdf.js')).default;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff';
  holder.innerHTML = buildStaffBookingsHtml({ report, rangeLabel });
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
