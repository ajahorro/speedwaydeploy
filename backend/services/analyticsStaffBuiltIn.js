'use strict';

const { parsePeriod } = require('./analyticsBuiltIn');

/**
 * Built-in (no API key) answers for the staff reports assistant. It covers bookings only: how many,
 * which ones, which services are booked most, the busiest days, and each technician's load. Questions
 * about money, payments, prices, customer contact details or accounts get a clear refusal.
 */

const shiftDay = (day, days) => new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const monthStart = (day) => day.slice(0, 7) + '-01';
const monthEnd = (day) => shiftDay(monthStart(shiftDay(monthStart(day), 32)), -1);

const HELP = [
  'I can answer questions about bookings, for example:',
  '• "Show me today\'s bookings", "bookings tomorrow", "what were the bookings on October 5?"',
  '• "How many bookings this week?" or "how many were cancelled last month?"',
  '• "What are the most booked services this month?"',
  '• "What was the busiest day last month?"',
  '• "Which technician has the most vehicles this week?"',
  '• "Create a PDF of this week\'s bookings" or "Export this month as CSV"'
].join('\n');

const REFUSAL = 'Staff reports cover bookings only. Payments, revenue, refunds, prices, customer contact details and accounts are not available to staff accounts. I can tell you about bookings, services, vehicles and technician workload instead.';

const words = (status) => String(status || '').replace(/_/g, ' ').toLowerCase();

function createStaffBuiltInAnswerer({ runTool, isDay, todayInManila }) {
  return async function answerStaffWithBuiltInRules({ question, range, db, adminId }) {
    const q = question.toLowerCase();
    const period = parsePeriod(question, range, { today: todayInManila(), isDay });
    const actions = [];
    const toolsUsed = [];
    const lines = [];
    const run = async (name, input) => {
      toolsUsed.push(name);
      return runTool(name, input, db, adminId, 'staff');
    };
    const reply = (answer) => ({ status: 200, body: { success: true, answer, actions, toolsUsed, mode: 'built-in' } });
    const labelOf = () => period.label + ' (' + period.from + (period.to !== period.from ? ' to ' + period.to : '') + ')';

    try {
      if (/(earn|revenue|sales|income|collected|money|peso|₱|paid|unpaid|owe|balance|payment|refund|price|cost|how much|phone|mobile|e-mail|email|contact|address|password|account|audit|\blogs?\b)/.test(q)
        && !/(booking.*(count|many))/.test(q)) {
        return reply(REFUSAL);
      }

      const wantsExport = /(export|download|csv)/.test(q);
      const wantsPdf = /\bpdf\b/.test(q);
      const wantsShow = /(show|open|display|create|generate|make|view)\s+(me\s+)?(a\s+|the\s+)?(report|bookings)|report\s+for/.test(q);
      const wantsCount = /(how many|count|number of|total)/.test(q);
      const wantsTop = /(most|top|popular|common|frequent).*(service|booked|requested)|which service|service.*(most|popular)/.test(q);
      const wantsBusy = /(busiest|quietest|slowest|busy|best|worst)\s*(day)?/.test(q) && /(day|date)/.test(q);
      const wantsTech = /(technician|mechanic|workload|who has the most|most vehicles|who is busiest|who got)/.test(q);
      const wantsBookings = /(booking|appointment|reservation|schedule|scheduled|vehicle|car|motorcycle|who.*(come|coming|booked))/.test(q);

      if (!(wantsExport || wantsPdf || wantsShow || wantsCount || wantsTop || wantsBusy || wantsTech || wantsBookings)) {
        return reply(HELP);
      }

      // schedules look ahead: a 'this week' / 'this month' report covers the whole period
      if (period.label === 'this week') period.to = shiftDay(period.from, 6);
      if (period.label === 'this month') period.to = monthEnd(period.from);
      const span = (Date.parse(period.to + 'T00:00:00Z') - Date.parse(period.from + 'T00:00:00Z')) / 86400000 + 1;
      if (span > 93) return reply('That range is too long for a bookings report (maximum 93 days). Try a month or less.');

      if (wantsTop || wantsBusy || wantsTech || wantsCount) {
        const { result } = await run('get_booking_stats', { from: period.from, to: period.to });
        if (result?.error) return reply(result.error);
        const totals = result.totals || {};
        if (wantsTop) {
          const top = (result.by_service || []).slice(0, 8);
          if (!top.length) lines.push('There are no booked services for ' + labelOf() + '.');
          else {
            lines.push('Most booked services for ' + labelOf() + ':');
            top.forEach((row) => lines.push('• ' + row.name + ': ' + row.count));
          }
        } else if (wantsBusy) {
          const days = (result.by_day || []).filter((row) => Number(row.bookings) > 0);
          if (!days.length) lines.push('There are no bookings for ' + labelOf() + '.');
          else {
            const quiet = /(quietest|slowest|worst)/.test(q);
            const sorted = [...days].sort((a, b) => Number(b.bookings) - Number(a.bookings));
            const pick = quiet ? sorted[sorted.length - 1] : sorted[0];
            lines.push((quiet ? 'Quietest' : 'Busiest') + ' day in ' + labelOf() + ': ' + pick.day + ' with ' + pick.bookings + ' booking(s) and ' + pick.vehicles + ' vehicle(s).');
          }
        } else if (wantsTech) {
          const techs = result.by_technician || [];
          if (!techs.length) lines.push('There are no assigned vehicles for ' + labelOf() + '.');
          else {
            lines.push('Vehicles per technician for ' + labelOf() + ':');
            techs.slice(0, 10).forEach((row) => lines.push('• ' + row.name + ': ' + row.vehicles + ' vehicle(s), ' + row.finished + ' finished'));
          }
        } else {
          lines.push('For ' + labelOf() + ': ' + (totals.bookings || 0) + ' booking(s) with ' + (totals.vehicles || 0) + ' vehicle(s).');
          lines.push('• Upcoming: ' + (totals.upcoming || 0) + ' · In progress: ' + (totals.in_progress || 0) + ' · Completed: ' + (totals.completed || 0) + ' · Cancelled or no-show: ' + (totals.cancelled || 0));
          if (Number(totals.walk_ins) > 0) lines.push('• Walk-ins: ' + totals.walk_ins);
        }
        if (wantsPdf || wantsShow || wantsExport) { /* continue to actions below */ } else {
          return reply(lines.join('\n'));
        }
      }

      if (wantsBookings && !wantsPdf && !wantsExport) {
        const { result } = await run('get_bookings_report', { from: period.from, to: period.to });
        if (result?.error) return reply(result.error);
        const list = result.bookings || [];
        const totals = result.totals || {};
        const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
        const dateOf = (iso) => new Date(iso).toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
        if (!list.length) lines.push('There are no bookings for ' + labelOf() + '.');
        else {
          lines.push((totals.bookings || list.length) + ' booking(s) for ' + labelOf() + ':');
          list.slice(0, 15).forEach((b) => lines.push('• ' + (period.from === period.to ? timeOf(b.start) : dateOf(b.start) + ' ' + timeOf(b.start)) + ' · ' + (b.customer || 'Customer')
            + ' · ' + (b.vehicles || []).join('; ') + ' · ' + words(b.status)));
          if ((totals.bookings || 0) > 15) lines.push('…and ' + (totals.bookings - 15) + ' more (open the report for the full list).');
        }
      }

      if (wantsPdf) {
        const act = await run('create_bookings_pdf', { from: period.from, to: period.to });
        if (act.action) actions.push(act.action);
        lines.push('Creating the PDF of these bookings.');
      } else if (wantsShow || wantsExport) {
        const act = await run('show_bookings_report', { from: period.from, to: period.to });
        if (act.action) actions.push(act.action);
        lines.push('Showing the report for ' + period.from + ' to ' + period.to + '.');
      }
      if (wantsExport) {
        const exported = await run('export_report_csv', {});
        if (exported.action) actions.push(exported.action);
        lines.push('Downloading the CSV.');
      }
      return reply(lines.join('\n') || HELP);
    } catch (error) {
      console.error('[staff-analytics-assistant] built-in mode failed:', error.message);
      return reply('I could not read the report right now. Try again in a moment.');
    }
  };
}

module.exports = { createStaffBuiltInAnswerer };
