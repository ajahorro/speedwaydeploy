'use strict';

const { createBuiltInAnswerer } = require('./analyticsBuiltIn');
const { createStaffBuiltInAnswerer } = require('./analyticsStaffBuiltIn');

/**
 * Admin analytics assistant (master plan 4.6).
 *
 * Two modes. WITHOUT an API key it runs the free built-in mode (analyticsBuiltIn.js: rule-based, no
 * paid service). WITH ANTHROPIC_API_KEY it uses Claude Haiku 4.5 over a plain fetch (no SDK) for
 * free-form questions; the key lives only on the server. The model never gets SQL or write access: it can only call the
 * small fixed set of read-only tools below, each of which runs as the signed-in ADMIN (their own
 * JWT, so the database's own admin checks and RLS still apply), plus two "action" tools that just
 * ask the page to change its date range or export the CSV.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 700;
const MAX_TOOL_ROUNDS = 4;
const MAX_QUESTION_CHARS = 600;
const MAX_TOOL_RESULT_CHARS = 7000;
const CACHE_TTL_MS = 60 * 1000;
const RATE_LIMIT_PER_MINUTE = 12;

const TOOLS = [
  {
    name: 'get_sales_report',
    description: 'Totals for a date range from the shop\'s single payment ledger: gross collected, transfer fees, net received, refunds, net revenue, pending verification, outstanding balance, deferred receivables ("to be received"), customer credit, average per booking, breakdown by payment method and top services.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD (Asia/Manila).' },
        to: { type: 'string', description: 'End date inclusive, YYYY-MM-DD (Asia/Manila).' }
      },
      required: ['from', 'to']
    }
  },
  {
    name: 'get_daily_series',
    description: 'Day-by-day net received, refunds and pending verification for a date range (max 92 days). Use it to compare periods or find the best/worst day.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'get_outstanding_bookings',
    description: 'Active bookings that still owe money, largest balance first (max 20), with customer, total, balance and any deferred "to be received" amount.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } } }
  },
  {
    name: 'get_bookings_report',
    description: 'The bookings that START in a date range (max 93 days) with customer, vehicles, services, status, total, paid and balance, plus totals. Use it for "what were the bookings on <date>", today, tomorrow, yesterday, this week.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string', description: 'First day, YYYY-MM-DD (Asia/Manila).' }, to: { type: 'string', description: 'Last day inclusive, YYYY-MM-DD.' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'show_bookings_report',
    description: 'Ask the Reports page to open its Bookings tab for a date range.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  {
    name: 'create_bookings_pdf',
    description: 'Ask the Reports page to create and download a PDF of the bookings and their money for a date range.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  {
    name: 'set_report_range',
    description: 'Ask the report page to show a date range (it fills the existing filters). Use when the admin asks to create, open or show a report for a period.',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'export_report_csv',
    description: 'Ask the report page to download the CSV for the range currently shown.',
    input_schema: { type: 'object', properties: {} }
  }
];

// Staff assistant: bookings only. No tool returns money, payments, prices, contact details or accounts.
const STAFF_TOOLS = [
  {
    name: 'get_bookings_report',
    description: 'The shop\'s bookings that START in a date range (max 93 days): reference, start, customer name, status, and for each vehicle its brand, model, plate, services and technician, plus counts. No money. Use it for "what were the bookings on <date>".',
    input_schema: {
      type: 'object',
      properties: { from: { type: 'string', description: 'First day, YYYY-MM-DD (Asia/Manila).' }, to: { type: 'string', description: 'Last day inclusive, YYYY-MM-DD.' } },
      required: ['from', 'to']
    }
  },
  {
    name: 'get_booking_stats',
    description: 'Booking figures for a date range (max 93 days): counts (bookings, vehicles, upcoming, in progress, completed, cancelled, walk-ins), most booked services, bookings per day, vehicles per technician, vehicles per vehicle type. Use it for "how many", "most booked service", "busiest day" and "who has the most vehicles".',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  {
    name: 'show_bookings_report',
    description: 'Ask the Reports page to show its bookings for a date range.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  {
    name: 'create_bookings_pdf',
    description: 'Ask the Reports page to create and download a PDF of the bookings for a date range.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }
  },
  {
    name: 'export_report_csv',
    description: 'Ask the Reports page to download the bookings CSV for the range currently shown.',
    input_schema: { type: 'object', properties: {} }
  }
];

const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
// Manila is UTC+8 with no daylight saving; the range is [from 00:00, to+1 00:00) shop time.
const dayStartIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 8 * 3600 * 1000).toISOString();
const dayEndIso = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 16 * 3600 * 1000).toISOString();

const validateRange = (input, maxDays = 366) => {
  const { from, to } = input || {};
  if (!isDay(from) || !isDay(to)) return { error: 'Dates must be YYYY-MM-DD.' };
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
  if (span < 0) return { error: 'The end date is before the start date.' };
  if (span + 1 > maxDays) return { error: `The range is too long (max ${maxDays} days).` };
  return { from, to };
};

const cache = new Map();
const cached = async (key, producer) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
};

const rateBuckets = new Map();
const allowRequest = (adminId) => {
  const now = Date.now();
  const recent = (rateBuckets.get(adminId) || []).filter((t) => now - t < 60000);
  if (recent.length >= RATE_LIMIT_PER_MINUTE) {
    rateBuckets.set(adminId, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(adminId, recent);
  return true;
};

/** Runs one staff tool as the signed-in staff member (their own JWT: the database function checks the switch). */
const runStaffTool = async (name, input, db, userId) => {
  try {
    if (name === 'get_bookings_report' || name === 'get_booking_stats') {
      const range = validateRange(input, 93);
      if (range.error) return { result: { error: range.error } };
      const data = await cached(`staffbk:${userId}:${range.from}:${range.to}`, async () => {
        const { data: report, error } = await db.rpc('staff_bookings_report', { p_from: dayStartIso(range.from), p_to: dayEndIso(range.to) });
        if (error) throw error;
        return report;
      });
      if (name === 'get_booking_stats') {
        return { result: { totals: data.totals, by_service: data.by_service, by_day: data.by_day, by_technician: data.by_technician, by_vehicle_type: data.by_vehicle_type } };
      }
      return {
        result: {
          totals: data.totals,
          shown: Math.min(25, (data.bookings || []).length),
          bookings: (data.bookings || []).slice(0, 25).map((b) => ({
            ref: b.reference, start: b.start, customer: b.customer, status: b.status, walk_in: b.walk_in,
            vehicles: (b.vehicles || []).map((v) => [v.brand, v.model, v.plate].filter(Boolean).join(' ') + ': ' + (v.services || []).join(', ') + (v.technician ? ' (' + v.technician + ')' : ''))
          }))
        }
      };
    }
    if (name === 'show_bookings_report' || name === 'create_bookings_pdf') {
      const range = validateRange(input, 93);
      if (range.error) return { result: { error: range.error } };
      return { result: { ok: true, range: `${range.from} to ${range.to}` }, action: { type: name === 'create_bookings_pdf' ? 'bookings_pdf' : 'show_bookings', from: range.from, to: range.to } };
    }
    if (name === 'export_report_csv') return { result: { ok: true }, action: { type: 'export_csv' } };
    return { result: { error: `Unknown tool ${name}.` } };
  } catch (error) {
    return { result: { error: 'The report could not be read right now.' } };
  }
};

/** Runs one tool as the admin. Returns { result, action? } and never throws. */
const runTool = async (name, input, db, adminId, scope = 'admin') => {
  if (scope === 'staff') return runStaffTool(name, input, db, adminId);
  try {
    if (name === 'get_sales_report') {
      const range = validateRange(input);
      if (range.error) return { result: { error: range.error } };
      const result = await cached(`sales:${adminId}:${range.from}:${range.to}`, async () => {
        const { data, error } = await db.rpc('sales_report', { p_from: dayStartIso(range.from), p_to: dayEndIso(range.to) });
        if (error) throw error;
        return data;
      });
      return { result };
    }
    if (name === 'get_daily_series') {
      const range = validateRange(input, 92);
      if (range.error) return { result: { error: range.error } };
      const result = await cached(`daily:${adminId}:${range.from}:${range.to}`, async () => {
        const { data, error } = await db.rpc('sales_report_daily', { p_from: dayStartIso(range.from), p_to: dayEndIso(range.to), p_tz: 'Asia/Manila' });
        if (error) throw error;
        return data;
      });
      return { result };
    }
    if (name === 'get_bookings_report') {
      const range = validateRange(input, 93);
      if (range.error) return { result: { error: range.error } };
      const result = await cached(`bookings:${adminId}:${range.from}:${range.to}`, async () => {
        const { data, error } = await db.rpc('bookings_report', { p_from: dayStartIso(range.from), p_to: dayEndIso(range.to) });
        if (error) throw error;
        return {
          totals: data.totals,
          shown: Math.min(25, (data.bookings || []).length),
          bookings: (data.bookings || []).slice(0, 25).map((b) => ({
            ref: b.reference, start: b.start_datetime, customer: b.customer_name, status: b.status, paid_status: b.paid_status,
            vehicles: (b.vehicles || []).map((v) => [v.brand, v.model, v.plate].filter(Boolean).join(' ') + ': ' + (v.services || []).map((s) => s.name).join(', ')),
            total: b.total, paid: b.paid, balance: b.balance, deferred: b.deferred
          }))
        };
      });
      return { result };
    }
    if (name === 'show_bookings_report' || name === 'create_bookings_pdf') {
      const range = validateRange(input, 93);
      if (range.error) return { result: { error: range.error } };
      return { result: { ok: true, range: `${range.from} to ${range.to}` }, action: { type: name === 'create_bookings_pdf' ? 'bookings_pdf' : 'show_bookings', from: range.from, to: range.to } };
    }
    if (name === 'get_outstanding_bookings') {
      const limit = Math.min(20, Math.max(1, Number(input?.limit) || 10));
      const result = await cached(`outstanding:${adminId}:${limit}`, async () => {
        const { data, error } = await db
          .from('booking_ledger_v')
          .select('booking_id, customer_name, booking_status, start_datetime, expected_amount, outstanding_amount, deferred_amount')
          .gt('outstanding_amount', 0)
          .not('booking_status', 'in', '(cancelled,released,no_show,flagged_noshow)')
          .order('outstanding_amount', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return data;
      });
      return { result };
    }
    if (name === 'set_report_range') {
      const range = validateRange(input);
      if (range.error) return { result: { error: range.error } };
      return { result: { ok: true, shown: `${range.from} to ${range.to}` }, action: { type: 'set_range', from: range.from, to: range.to } };
    }
    if (name === 'export_report_csv') {
      return { result: { ok: true }, action: { type: 'export_csv' } };
    }
    return { result: { error: `Unknown tool ${name}.` } };
  } catch (error) {
    return { result: { error: 'The report could not be read right now.' } };
  }
};

const todayInManila = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const systemPrompt = (range) => [
  'You are the finance assistant for Comar Garage, a car-care shop in the Philippines. You help an administrator read the shop\'s payment reports.',
  `Today is ${todayInManila()} (Asia/Manila). The report page currently shows ${range?.from || '?'} to ${range?.to || '?'}.`,
  'Rules:',
  '- Answer only from tool results. Never invent or estimate a figure; if a tool returns nothing or an error, say so.',
  '- Money is Philippine pesos; write it as ₱1,234.50.',
  '- Net received is money that reached the shop (transfer fees are not revenue). "Deferred receivables" are balances an admin marked "to be received" and are NOT money received.',
  '- Convert phrases like "this week" or "last month" to exact YYYY-MM-DD dates before calling a tool, and say which dates you used.',
  '- For questions about bookings on a day or period, call get_bookings_report and list them briefly (time, customer, vehicle, status, balance).',
  '- When asked to create, open or show a money report, call set_report_range; for a bookings report call show_bookings_report; for a PDF of bookings call create_bookings_pdf; to download the CSV call export_report_csv; then confirm in one sentence.',
  '- Be brief: a short answer first, then at most a few bullet points. You cannot change any data.'
].join('\n');

const staffSystemPrompt = (range) => [
  'You are the bookings assistant for Comar Garage, a car-care shop in the Philippines. You help a staff member read the shop\'s BOOKING reports.',
  `Today is ${todayInManila()} (Asia/Manila). The report page currently shows ${range?.from || '?'} to ${range?.to || '?'}.`,
  'Rules:',
  '- You only know about bookings: which bookings, vehicles, services, statuses, technicians, and counts. Answer only from tool results. Never invent or estimate a figure; if a tool returns nothing or an error, say so.',
  '- You have no information about money. If asked about payments, revenue, refunds, prices, balances, discounts, customer phone numbers or emails, accounts, or the audit log, say briefly that staff reports cover bookings only, and offer a booking-related alternative.',
  '- Convert phrases like "this week" or "last month" to exact YYYY-MM-DD dates before calling a tool, and say which dates you used.',
  '- For questions about bookings on a day or period, call get_bookings_report and list them briefly (time, customer, vehicle, status). For counts, popular services, busiest days or technician workload, call get_booking_stats.',
  '- When asked to show or open the report, call show_bookings_report; for a PDF call create_bookings_pdf; for the CSV call export_report_csv.',
  '- Be brief: a short answer first, then at most a few bullet points. You cannot change any data.'
].join('\n');

const callModel = async (apiKey, body) => {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Model request failed (${response.status})`);
    error.status = response.status;
    error.detail = detail.slice(0, 300);
    throw error;
  }
  return response.json();
};

/**
 * @param {object} args
 * @param {string} args.question
 * @param {{from?:string,to?:string}} [args.range]
 * @param {Array<{role:'user'|'assistant',content:string}>} [args.history]  earlier turns (text only)
 * @param {object} args.db        Supabase client acting as the signed-in admin
 * @param {string} args.adminId
 * @param {'admin'|'staff'} [args.scope] staff = bookings only, no money (the staff reports assistant)
 */
async function askAnalyticsAssistant({ question, range, history = [], db, adminId, scope = 'admin' }) {
  const staffScope = scope === 'staff';
  const apiKey = process.env.ANTHROPIC_API_KEY;

  const text = String(question || '').trim().slice(0, MAX_QUESTION_CHARS);
  if (!text) return { status: 400, body: { success: false, error: 'Ask a question first.' } };
  if (!allowRequest(adminId)) return { status: 429, body: { success: false, error: 'Too many questions. Wait a moment and try again.' } };

  // No key = free built-in mode (no paid service). The model is optional.
  if (!apiKey) return (staffScope ? answerStaffWithBuiltInRules : answerWithBuiltInRules)({ question: text, range, db, adminId });

  const messages = [
    ...history
      .filter((turn) => turn && ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string')
      .slice(-6)
      .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 1500) })),
    { role: 'user', content: text }
  ];
  const actions = [];
  const toolsUsed = [];

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
      const reply = await callModel(apiKey, {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: staffScope ? staffSystemPrompt(range) : systemPrompt(range),
        tools: staffScope ? STAFF_TOOLS : TOOLS,
        messages
      });

      const toolCalls = (reply.content || []).filter((block) => block.type === 'tool_use');
      if (reply.stop_reason !== 'tool_use' || toolCalls.length === 0) {
        const answer = (reply.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
        return { status: 200, body: { success: true, answer: answer || 'I could not produce an answer.', actions, toolsUsed } };
      }
      if (round === MAX_TOOL_ROUNDS) break;

      messages.push({ role: 'assistant', content: reply.content });
      const results = [];
      for (const call of toolCalls) {
        const { result, action } = await runTool(call.name, call.input, db, adminId, scope);
        toolsUsed.push(call.name);
        if (action) actions.push(action);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { status: 200, body: { success: true, answer: 'That needed too many steps. Try a narrower question.', actions, toolsUsed } };
  } catch (error) {
    console.error('[analytics-assistant] model call failed:', error.message, error.detail || '');
    const status = error.status === 429 ? 429 : 502;
    return { status, body: { success: false, error: 'The assistant is unavailable right now. Try again shortly.' } };
  }
}

const answerWithBuiltInRules = createBuiltInAnswerer({ runTool, isDay, todayInManila });
const answerStaffWithBuiltInRules = createStaffBuiltInAnswerer({ runTool, isDay, todayInManila });

module.exports = { askAnalyticsAssistant, TOOLS, STAFF_TOOLS, validateRange, dayStartIso, dayEndIso };
