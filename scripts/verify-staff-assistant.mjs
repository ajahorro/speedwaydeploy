// The staff reports assistant covers bookings only: refuses money and contact questions, answers booking questions
// from staff_bookings_report, and can only ask the page for booking actions. No network, no database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
delete process.env.ANTHROPIC_API_KEY;
const { askAnalyticsAssistant, STAFF_TOOLS } = require('../backend/services/analyticsAssistant.js');

const report = {
  totals: { bookings: 2, vehicles: 3, upcoming: 1, in_progress: 1, completed: 0, cancelled: 0, walk_ins: 1 },
  bookings: [
    { reference: 'AAAA1111', start: '2026-10-06T02:00:00Z', customer: 'Ana Cruz', status: 'confirmed', walk_in: false, vehicles: [{ brand: 'Toyota', model: 'Vios', plate: 'ABC123', services: ['Premium Car Wash'], technician: 'Juan' }] },
    { reference: 'BBBB2222', start: '2026-10-06T04:00:00Z', customer: 'Ben Lim', status: 'in_progress', walk_in: true, vehicles: [{ brand: 'Honda', model: 'CRV', plate: 'XYZ789', services: ['Interior Detailing', 'Waxing'], technician: 'Maria' }] }
  ],
  by_service: [{ name: 'Premium Car Wash', count: 5 }, { name: 'Waxing', count: 2 }],
  by_day: [{ day: '2026-10-06', bookings: 2, vehicles: 3 }, { day: '2026-10-07', bookings: 1, vehicles: 1 }],
  by_technician: [{ name: 'Juan', vehicles: 3, finished: 1 }, { name: 'Maria', vehicles: 1, finished: 0 }],
  by_vehicle_type: [{ type: 'Sedan', vehicles: 2 }]
};
const calls = [];
const db = { rpc: async (name, args) => { calls.push(name); return { data: report, error: null }; } };
const ask = (question, range) => askAnalyticsAssistant({ question, range, db, adminId: 'staff-' + Math.random(), scope: 'staff' });

// the tool list has no money tool
assert.ok(STAFF_TOOLS.every((tool) => !/sales|outstanding|daily_series/.test(tool.name)), 'no money tools for staff');
assert.ok(STAFF_TOOLS.every((tool) => !/(₱|peso|payment|refund|phone)/i.test(tool.description) || /No money|no money/.test(tool.description)), 'tool descriptions stay booking-only');

for (const question of ['How much did we earn this week?', 'Who owes us money?', 'Show refunds for last month', "What is Ana's phone number?", 'Show me the audit log']) {
  const { body } = await ask(question);
  assert.match(body.answer, /bookings only/i, `refuses: ${question}`);
}
assert.equal(calls.length, 0, 'refused questions never reach the database');

let { body } = await ask("Show me today's bookings");
assert.match(body.answer, /Ana Cruz/);
assert.match(body.answer, /Ben Lim/);
assert.doesNotMatch(body.answer, /₱|paid|balance|total/i, 'a booking list has no money');

({ body } = await ask('How many bookings this week?'));
assert.match(body.answer, /2 booking\(s\) with 3 vehicle\(s\)/);

({ body } = await ask('What are the most booked services this month?'));
assert.match(body.answer, /Premium Car Wash: 5/);

({ body } = await ask('What was the busiest day last month?'));
assert.match(body.answer, /2026-10-06 with 2 booking/);

({ body } = await ask('Which technician has the most vehicles this week?'));
assert.match(body.answer, /Juan: 3 vehicle/);

({ body } = await ask("Create a PDF of this week's bookings"));
assert.deepEqual(body.actions.map((a) => a.type), ['bookings_pdf']);

({ body } = await ask('Export this month as CSV'));
assert.ok(body.actions.some((a) => a.type === 'export_csv'));

({ body } = await ask('hello there'));
assert.match(body.answer, /questions about bookings/);

assert.ok(calls.every((name) => name === 'staff_bookings_report'), 'only the staff report function is ever called');
console.log('staff reports assistant OK (refuses money and contacts, answers bookings, booking-only actions)');
