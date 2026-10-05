// End-to-end check of the analytics assistant's tool loop WITHOUT a real API key: a tiny fake
// Anthropic server scripts two model turns (tool call, then final answer) and the real tools run
// against a scratch Supabase as a signed-in admin.
//
//   SUPABASE_URL=http://127.0.0.1:55421 SUPABASE_SERVICE_ROLE_KEY=... ADMIN_JWT=... \
//   node scripts/verify-analytics-assistant.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('../backend/node_modules/@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_JWT } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ADMIN_JWT) {
  console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ADMIN_JWT (a scratch admin session token).');
  process.exit(2);
}

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(body);
    seen.push(payload);
    const turn = seen.length;
    res.setHeader('content-type', 'application/json');
    if (turn === 1) {
      res.end(JSON.stringify({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'tu_1', name: 'get_sales_report', input: { from: '2026-09-01', to: '2026-10-31' } },
          { type: 'tool_use', id: 'tu_2', name: 'set_report_range', input: { from: '2026-09-01', to: '2026-10-31' } },
          { type: 'tool_use', id: 'tu_3', name: 'get_outstanding_bookings', input: { limit: 3 } },
          { type: 'tool_use', id: 'tu_4', name: 'drop_database', input: {} }
        ]
      }));
    } else {
      res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Net revenue is shown above.' }] }));
    }
  });
});
await new Promise((resolve) => server.listen(0, resolve));
process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${server.address().port}/v1/messages`;
process.env.ANTHROPIC_API_KEY = 'test-key';

const { askAnalyticsAssistant, TOOLS } = require('../backend/services/analyticsAssistant.js');
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${ADMIN_JWT}` } }
});

const out = await askAnalyticsAssistant({ question: 'Show me September and October', range: { from: '2026-10-01', to: '2026-10-05' }, db, adminId: 'verify-admin' });
assert.equal(out.status, 200, JSON.stringify(out.body));
assert.equal(out.body.answer, 'Net revenue is shown above.');
assert.deepEqual(out.body.actions, [{ type: 'set_range', from: '2026-09-01', to: '2026-10-31' }], 'page action returned');
assert.deepEqual(out.body.toolsUsed, ['get_sales_report', 'set_report_range', 'get_outstanding_bookings', 'drop_database']);

// the second model turn received real tool results, and the unknown tool was refused
const results = seen[1].messages.at(-1).content;
const sales = JSON.parse(results.find((r) => r.tool_use_id === 'tu_1').content);
assert.ok('net_received' in sales && 'deferred_receivables' in sales, 'sales_report ran as the admin: ' + JSON.stringify(sales).slice(0, 120));
assert.match(results.find((r) => r.tool_use_id === 'tu_4').content, /Unknown tool/);
assert.ok(Array.isArray(JSON.parse(results.find((r) => r.tool_use_id === 'tu_3').content)));

// the model is only ever offered read-only tools and the fixed system rules
assert.deepEqual(seen[0].tools.map((t) => t.name), TOOLS.map((t) => t.name));
assert.equal(seen[0].model, 'claude-haiku-4-5-20251001');
assert.ok(seen[0].max_tokens <= 700);
assert.match(seen[0].system, /Never invent/);

// no key -> clear 503, bad input -> 400
delete process.env.ANTHROPIC_API_KEY;
assert.equal((await askAnalyticsAssistant({ question: 'x', db, adminId: 'a' })).status, 503);
process.env.ANTHROPIC_API_KEY = 'test-key';
assert.equal((await askAnalyticsAssistant({ question: '   ', db, adminId: 'a' })).status, 400);

// per-admin rate limit
let limited = false;
for (let i = 0; i < 20 && !limited; i += 1) {
  limited = (await askAnalyticsAssistant({ question: 'hi', db, adminId: 'rate-test' })).status === 429;
}
assert.ok(limited, 'rate limit applies');

server.close();
console.log('analytics assistant OK (tool loop, admin-scoped reads, actions, guards)');
