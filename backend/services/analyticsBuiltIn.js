'use strict';

/**
 * Built-in mode of the analytics assistant: no API key, no paid service, no network call.
 * It reads the question for a period and an intent, runs the same read-only tools the model
 * would, and writes the answer from the real figures. Anything it does not understand gets a
 * short "here is what I can answer" reply rather than a guess.
 */

const peso = (value) => '₱' + Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shiftDay = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const monthStart = (day) => day.slice(0, 7) + '-01';
const monthEnd = (day) => shiftDay(monthStart(shiftDay(monthStart(day), 32)), -1);
const weekStart = (day) => {
  const dow = new Date(day + 'T00:00:00Z').getUTCDay();
  return shiftDay(day, -((dow + 6) % 7)); // weeks start on Monday
};

const HELP = [
  'I can answer questions like:',
  '• "How much did we earn this week / last month / last 14 days?"',
  '• "Compare this week with last week"',
  '• "Who owes us the most right now?"',
  '• "What was our best day last month?"',
  '• "Show me today\'s bookings", "bookings tomorrow", "what were the bookings on October 5?"',
  '• "Create a PDF of this week\'s bookings"',
  '• "Create a report for last month" or "Export this month as CSV"'
].join('\n');

/** Reads a period out of the question; falls back to the range on screen. */
const parsePeriod = (question, fallback, { today, isDay }) => {
  const q = question.toLowerCase();
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (y, m, d) => {
    const day = y + '-' + pad(m) + '-' + pad(d);
    return isDay(day) && new Date(day + 'T00:00:00Z').getUTCMonth() === m - 1 ? day : null;
  };
  const thisYear = Number(today.slice(0, 4));
  let hit;
  if ((hit = q.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) { const d = dayOf(Number(hit[1]), Number(hit[2]), Number(hit[3])); if (d) return { from: d, to: d, label: d, explicit: true }; }
  const monthPattern = MONTHS.map((m) => m.slice(0, 3)).join('|');
  if ((hit = q.match(new RegExp('\\b(' + monthPattern + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?'))) ) {
    const d = dayOf(Number(hit[3] || thisYear), MONTHS.findIndex((m) => m.startsWith(hit[1])) + 1, Number(hit[2]));
    if (d) return { from: d, to: d, label: d, explicit: true };
  }
  if ((hit = q.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(' + monthPattern + ')[a-z]*(?:,?\\s+(\\d{4}))?')))) {
    const d = dayOf(Number(hit[3] || thisYear), MONTHS.findIndex((m) => m.startsWith(hit[2])) + 1, Number(hit[1]));
    if (d) return { from: d, to: d, label: d, explicit: true };
  }
  if ((hit = q.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    const y = hit[3] ? (hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3])) : thisYear;
    const d = dayOf(y, Number(hit[1]), Number(hit[2]));
    if (d) return { from: d, to: d, label: d, explicit: true };
  }
  if (/day after tomorrow/.test(q)) { const d = shiftDay(today, 2); return { from: d, to: d, label: 'the day after tomorrow', explicit: true }; }
  if (/\btomorrow\b/.test(q)) { const d = shiftDay(today, 1); return { from: d, to: d, label: 'tomorrow', explicit: true }; }
  if (/next\s+week/.test(q)) { const s = shiftDay(weekStart(today), 7); return { from: s, to: shiftDay(s, 6), label: 'next week', explicit: true }; }
  if (/next\s+month/.test(q)) { const nm = shiftDay(monthEnd(today), 1); return { from: monthStart(nm), to: monthEnd(nm), label: 'next month', explicit: true }; }
  const lastDays = q.match(/last\s+(\d{1,3})\s+days?/);
  if (lastDays) return { from: shiftDay(today, -(Number(lastDays[1]) - 1)), to: today, label: 'the last ' + lastDays[1] + ' days', explicit: true };
  if (/\btoday\b/.test(q)) return { from: today, to: today, label: 'today', explicit: true };
  if (/\byesterday\b/.test(q)) { const y = shiftDay(today, -1); return { from: y, to: y, label: 'yesterday', explicit: true }; }
  if (/last\s+week/.test(q)) { const s = shiftDay(weekStart(today), -7); return { from: s, to: shiftDay(s, 6), label: 'last week', explicit: true }; }
  if (/this\s+week/.test(q)) return { from: weekStart(today), to: today, label: 'this week', explicit: true };
  if (/last\s+month/.test(q)) { const prev = shiftDay(monthStart(today), -1); return { from: monthStart(prev), to: monthEnd(prev), label: 'last month', explicit: true }; }
  if (/this\s+month/.test(q)) return { from: monthStart(today), to: today, label: 'this month', explicit: true };
  if (/this\s+year/.test(q)) return { from: today.slice(0, 4) + '-01-01', to: today, label: 'this year', explicit: true };
  if (fallback && isDay(fallback.from) && isDay(fallback.to)) {
    return { from: fallback.from, to: fallback.to, label: 'the range on screen (' + fallback.from + ' to ' + fallback.to + ')', explicit: false };
  }
  return { from: monthStart(today), to: today, label: 'this month', explicit: false };
};

function createBuiltInAnswerer({ runTool, isDay, todayInManila }) {
  return async function answerWithBuiltInRules({ question, range, db, adminId }) {
    const q = question.toLowerCase();
    const period = parsePeriod(question, range, { today: todayInManila(), isDay });
    const actions = [];
    const toolsUsed = [];
    const lines = [];
    const run = async (name, input) => {
      toolsUsed.push(name);
      return runTool(name, input, db, adminId);
    };

    try {
      const wantsExport = /(export|download|csv)/.test(q);
      const wantsReport = /(create|open|show|generate|make|view)\s+(me\s+)?(a\s+|the\s+)?report|report\s+for/.test(q);
      const wantsOwed = /(owe|owes|outstanding|unpaid|balance|receivable|to be received)/.test(q);
      const wantsMoney = /(earn|revenue|sales|income|collected|made)/.test(q);
      const wantsCompare = /(compare|versus|\bvs\b|difference|than)/.test(q);
      const wantsBest = /(best|worst|busiest|highest|lowest)\s+day/.test(q);
      const wantsBookings = /(booking|appointment|reservation|schedule|scheduled|who.*(come|coming|booked))/.test(q);
      const wantsPdf = /\bpdf\b/.test(q);
      const understood = wantsBookings || wantsPdf || wantsExport || wantsReport || wantsOwed || wantsMoney || wantsCompare || wantsBest
        || /(refund|pending|verif|payment|how much|total|report|average)/.test(q);

      if (!understood) {
        return { status: 200, body: { success: true, answer: HELP, actions, toolsUsed, mode: 'built-in' } };
      }

      if (wantsBookings || (wantsPdf && !wantsMoney && !wantsOwed)) {
        // schedules look ahead: a 'this week' / 'this month' bookings report covers the whole period
        if (period.label === 'this week') period.to = shiftDay(period.from, 6);
        if (period.label === 'this month') period.to = monthEnd(period.from);
        const span = (Date.parse(period.to + 'T00:00:00Z') - Date.parse(period.from + 'T00:00:00Z')) / 86400000 + 1;
        if (span > 93) {
          lines.push('That range is too long for a bookings report (maximum 93 days). Try a month or less.');
        } else {
          const { result } = await run('get_bookings_report', { from: period.from, to: period.to });
          if (result?.error) {
            lines.push(result.error);
          } else {
            const list = result.bookings || [];
            const totals = result.totals || {};
            const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
            const dateOf = (iso) => new Date(iso).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
            if (!list.length) {
              lines.push('There are no bookings for ' + period.label + ' (' + period.from + (period.to !== period.from ? ' to ' + period.to : '') + ').');
            } else {
              lines.push((totals.count || list.length) + ' booking(s) for ' + period.label + ' (' + period.from + (period.to !== period.from ? ' to ' + period.to : '') + '), worth ' + peso(totals.total_value) + ': received ' + peso(totals.paid) + ', balance owed ' + peso(totals.balance) + '.');
              list.slice(0, 15).forEach((b) => lines.push('• ' + (period.from === period.to ? timeOf(b.start) : dateOf(b.start) + ' ' + timeOf(b.start)) + ' · ' + b.customer + ' · ' + ((b.vehicles || [])[0] || 'no vehicle') + ' · ' + String(b.status).replace(/_/g, ' ') + ' · total ' + peso(b.total) + ', balance ' + peso(b.balance)));
              if ((totals.count || 0) > 15) lines.push('…and ' + (totals.count - 15) + ' more (open the Bookings tab for the full list).');
            }
          }
          const showIt = wantsPdf || wantsReport || /(show|open|display|report to me|report me)/.test(q);
          if (showIt) {
            const act = await run(wantsPdf ? 'create_bookings_pdf' : 'show_bookings_report', { from: period.from, to: period.to });
            if (act.action) actions.push(act.action);
            lines.push(wantsPdf ? 'Creating the PDF of these bookings and their payments.' : 'Showing them in the Bookings tab.');
          }
        }
        return { status: 200, body: { success: true, answer: lines.join('\n'), actions, toolsUsed, mode: 'built-in' } };
      }

      if (wantsOwed && !wantsMoney) {
        const { result } = await run('get_outstanding_bookings', { limit: 10 });
        if (!Array.isArray(result) || result.length === 0) {
          lines.push('No active booking has an unpaid balance right now.');
        } else {
          const total = result.reduce((sum, row) => sum + Number(row.outstanding_amount || 0), 0);
          lines.push('Largest unpaid balances right now (top ' + result.length + ', together ' + peso(total) + '):');
          result.forEach((row) => lines.push('• ' + (row.customer_name || 'Customer') + ': ' + peso(row.outstanding_amount)
            + (Number(row.deferred_amount) > 0 ? ' (' + peso(row.deferred_amount) + ' marked to be received)' : '')));
        }
      } else if (wantsBest) {
        const { result } = await run('get_daily_series', { from: period.from, to: period.to });
        const rows = Array.isArray(result) ? result.filter((row) => Number(row.net_received) > 0) : [];
        if (!rows.length) {
          lines.push('There is no recorded revenue for ' + period.label + '.');
        } else {
          const lowest = /(worst|lowest)/.test(q);
          const sorted = [...rows].sort((a, b) => Number(b.net_received) - Number(a.net_received));
          const pick = lowest ? sorted[sorted.length - 1] : sorted[0];
          lines.push((lowest ? 'Lowest' : 'Best') + ' day in ' + period.label + ': ' + (pick.day || pick.date || pick.bucket) + ' with ' + peso(pick.net_received) + ' net received.');
        }
      } else if (wantsCompare && !wantsReport) {
        const length = (Date.parse(period.to + 'T00:00:00Z') - Date.parse(period.from + 'T00:00:00Z')) / 86400000 + 1;
        const prev = { from: shiftDay(period.from, -length), to: shiftDay(period.from, -1) };
        const [current, before] = await Promise.all([run('get_sales_report', { from: period.from, to: period.to }), run('get_sales_report', prev)]);
        const now = Number(current.result?.net_revenue || 0);
        const was = Number(before.result?.net_revenue || 0);
        const diff = now - was;
        const pct = was > 0 ? ' (' + (diff >= 0 ? '+' : '') + ((diff / was) * 100).toFixed(1) + '%)' : '';
        lines.push('Net revenue for ' + period.label + ' (' + period.from + ' to ' + period.to + '): ' + peso(now) + '.');
        lines.push('The period before it (' + prev.from + ' to ' + prev.to + '): ' + peso(was) + '.');
        lines.push('Change: ' + (diff >= 0 ? '+' : '−') + peso(Math.abs(diff)) + pct + '.');
      } else {
        const { result } = await run('get_sales_report', { from: period.from, to: period.to });
        if (result?.error) {
          lines.push(result.error);
        } else {
          lines.push('For ' + period.label + ' (' + period.from + ' to ' + period.to + '):');
          lines.push('• Net revenue: ' + peso(result.net_revenue) + ' (received ' + peso(result.net_received) + ', refunds ' + peso(result.refunds) + ')');
          lines.push('• ' + result.transaction_count + ' payment(s) across ' + result.booking_count + ' booking(s); average ' + peso(result.average_ticket) + ' per booking');
          if (Number(result.pending_verification) > 0) lines.push('• Awaiting verification: ' + peso(result.pending_verification) + ' (not counted as revenue)');
          lines.push('• Unpaid balance on active bookings today: ' + peso(result.outstanding_balance)
            + (Number(result.deferred_receivables) > 0 ? ', of which ' + peso(result.deferred_receivables) + ' is marked to be received' : ''));
          const top = (result.by_method || [])[0];
          if (top) lines.push('• Most used method: ' + top.method + ' (' + peso(top.net_received) + ')');
        }
      }

      if (wantsReport || wantsExport) {
        const set = await run('set_report_range', { from: period.from, to: period.to });
        if (set.action) actions.push(set.action);
        lines.push('Showing the report for ' + period.from + ' to ' + period.to + '.');
      }
      if (wantsExport) {
        const exported = await run('export_report_csv', {});
        if (exported.action) actions.push(exported.action);
        lines.push('Downloading the CSV.');
      }
      return { status: 200, body: { success: true, answer: lines.join('\n'), actions, toolsUsed, mode: 'built-in' } };
    } catch (error) {
      console.error('[analytics-assistant] built-in mode failed:', error.message);
      return { status: 200, body: { success: true, answer: 'I could not read the report right now. Try again in a moment.', actions: [], toolsUsed, mode: 'built-in' } };
    }
  };
}

module.exports = { createBuiltInAnswerer, parsePeriod, HELP };
