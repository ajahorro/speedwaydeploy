/**
 * tests/rbac_route_lockdown.test.js
 * ============================================================================
 * PART 2 — RBAC & ENDPOINT SECURITY (Tests 1.1 - 1.4)
 *
 * Verifies the four previously-unauthenticated privileged routes now reject
 * anonymous / non-admin callers:
 *
 *   Test 1.1  POST   /api/admin/purge-bookings        anonymous  -> 401/403
 *   Test 1.2  POST   /api/admin/purge-bookings        bad secret -> rejected
 *   Test 1.3  POST   /api/bookings/admin-cancel       customer   -> 403
 *   Test 1.4  POST/PATCH/DELETE /api/admin/blocked-slots[...]  anonymous -> 401/403
 *
 * HOW THIS IS TESTED — AND WHAT IT DOES NOT PROVE
 * ----------------------------------------------
 * `backend/server.js` calls `app.listen()` at module scope and has no
 * `module.exports`, so it cannot be imported by a test without binding a port and
 * requiring live Supabase credentials. Instead this file does TWO things:
 *
 *   1. BEHAVIOURAL — boots a real Express app on an ephemeral port and mounts the
 *      REAL `requireAdmin` implementation, extracted verbatim from server.js, in
 *      front of routes that mirror each handler's guard block. Requests are made
 *      over real HTTP, so the 401/403 responses are genuinely observed.
 *
 *   2. STRUCTURAL — asserts that server.js wires that same guard into each of the
 *      five real handlers, and that the purge route no longer has a hardcoded
 *      secret fallback.
 *
 * (1) proves the guard behaves correctly. (2) proves it is actually attached. A
 * test that only did (1) would pass even if the routes were still unguarded — the
 * classic "tests the mock, not the system" failure.
 *
 * Run: node tests/rbac_route_lockdown.test.js
 * ============================================================================
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
// `express` lives in backend/node_modules, not the repo root, so a bare require
// from tests/ cannot resolve it. Resolved explicitly against backend/ so the
// harness uses the SAME express version the server does.
const express = require(path.join(__dirname, '..', 'backend', 'node_modules', 'express'));

let passed = 0;
let failed = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${label}\n      ${err.message}`);
    failed += 1;
  }
};
const checkAsync = async (label, fn) => {
  try {
    await fn();
    console.log(`PASS  ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`FAIL  ${label}\n      ${err.message}`);
    failed += 1;
  }
};

/**
 * Strip comments so an assertion about CODE is not tripped by a COMMENT.
 *
 * The `admin-cancel` handler carries a note explaining that it USED to write
 * `actor_name: 'ADMIN'`. A raw word-match on the route body finds that
 * explanation and reports a failure against a defect that is already fixed — a
 * test that cries wolf is a test people learn to ignore.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\/\/.*$/gm, '');

/**
 * Extract the source of a single route handler, from its `app.<verb>('<path>'`
 * declaration up to the `\n});` that closes it.
 *
 * WHY NOT "up to the next `\napp.`": the handlers in server.js are separated by
 * comments and blank lines, and `admin-cancel` is followed by `undo-no-show`
 * and `release`. Slicing to the next `\napp.` therefore swallowed the WHOLE of
 * those following handlers, so an assertion like "admin-cancel must not contain
 * `actor_name: 'ADMIN'`" was really asserting it of every route until the next
 * one — and failed on `/api/bookings/release`, which legitimately does write
 * that actor. Bounding at the handler's own closing brace tests the route it
 * claims to test.
 */
const routeBody = (source, route) => {
  const idx = source.indexOf(route);
  if (idx === -1) return null;
  const end = source.indexOf('\n});', idx);
  return end === -1 ? source.slice(idx) : source.slice(idx, end);
};

const SERVER_PATH = path.join(__dirname, '..', 'backend', 'server.js');
const SERVER = fs.readFileSync(SERVER_PATH, 'utf8');

/** Send a real HTTP request and resolve { status, body }. */
const request = (port, method, urlPath, { token, body } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(data); } catch { parsed = data; }
      resolve({ status: res.statusCode, body: parsed });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

(async () => {
  // ── Extract the REAL requireAdmin from server.js ───────────────────────────
  // Copied verbatim so the behavioural tests exercise the shipped logic rather
  // than a re-implementation. If the source changes shape, the extraction guard
  // below fails loudly instead of silently testing nothing.
  const startMarker = 'const requireAdmin = async (req) => {';
  const start = SERVER.indexOf(startMarker);
  assert.ok(start !== -1, 'requireAdmin must exist in server.js');
  const bodyStart = SERVER.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < SERVER.length; i += 1) {
    if (SERVER[i] === '{') depth += 1;
    else if (SERVER[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const requireAdminSource = SERVER.slice(start, end);

  // A stub Supabase whose getUser/profile behaviour each test controls.
  let authBehaviour = { user: null, error: null };
  let profileBehaviour = null;

  const supabaseAdminStub = {
    auth: {
      getUser: async () => ({ data: { user: authBehaviour.user }, error: authBehaviour.error }),
    },
    // Both terminal methods are provided on purpose.
    //
    // The stub previously offered ONLY `maybeSingle`, while the real
    // `requireAdmin` in server.js calls `.single()`. The extraction below copies
    // the SHIPPED function verbatim, so the guard reached for `.single` on an
    // object that did not have it and threw
    //     TypeError: supabaseAdmin.from(...).select(...).eq(...).single is not a function
    // inside the route, which surfaced as a raw 500 instead of the 403 the
    // assertions expect — the whole suite died on the first non-admin case.
    //
    // Which method the guard uses is a real decision, so it is asserted in
    // `concurrency_timezone_rbac.test.js` rather than quietly accepted here.
    // This stub just has to answer whichever one the shipped code calls, so the
    // behavioural tests can measure the STATUS CODE, which is what they are for.
    //
    // `single()` mirrors PostgREST: it returns a PGRST116 error when no row
    // matches, and `maybeSingle()` returns `{ data: null, error: null }`.
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => (profileBehaviour
            ? { data: profileBehaviour, error: null }
            : { data: null, error: { code: 'PGRST116', message: 'no rows returned' } }),
          maybeSingle: async () => ({ data: profileBehaviour, error: null }),
        }),
      }),
    }),
  };

  // eslint-disable-next-line no-new-func
  const makeRequireAdmin = new Function('supabaseAdmin', `${requireAdminSource}\n return requireAdmin;`);

  // ── Build the harness app ─────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  const requireAdmin = makeRequireAdmin(supabaseAdminStub);

  // Mirrors the guard block now present in each real handler.
  const guard = async (req, res, next) => {
    const admin = await requireAdmin(req);
    if (!admin) return res.status(403).json({ success: false, error: 'Forbidden: an active admin session is required.' });
    req.admin = admin;
    return next();
  };

  app.post('/api/admin/purge-bookings', guard, (req, res) => {
    // Mirrors the real handler's second factor.
    const configuredSecret = process.env.DEBUG_SECRET;
    if (!configuredSecret) {
      return res.status(503).json({ success: false, error: 'Purge is disabled: DEBUG_SECRET is not configured on this server.' });
    }
    const { secret } = req.body || {};
    if (!secret || secret !== configuredSecret) {
      return res.status(403).json({ success: false, error: 'Forbidden: invalid secret' });
    }
    return res.json({ success: true, purged: true });
  });

  app.post('/api/bookings/admin-cancel', guard, (req, res) => res.json({ success: true }));
  app.post('/api/admin/blocked-slots', guard, (req, res) => res.json({ success: true }));
  app.patch('/api/admin/blocked-slots/:id', guard, (req, res) => res.json({ success: true }));
  app.delete('/api/admin/blocked-slots/:id', guard, (req, res) => res.json({ success: true }));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  // ── Test 1.1 — purge route lockdown ───────────────────────────────────────
  console.log('=== Test 1.1: PURGE ROUTE LOCKDOWN (anonymous / missing token) ===');

  await checkAsync('anonymous request with NO token is rejected (401/403)', async () => {
    authBehaviour = { user: null, error: { message: 'no token' } };
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { body: { secret: 'anything' } });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
    assert.notStrictEqual(res.body?.success, true, 'the purge must not report success');
  });

  await checkAsync('an invalid/garbage token is rejected', async () => {
    authBehaviour = { user: null, error: { message: 'invalid JWT' } };
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'not-a-real-jwt', body: { secret: 'x' } });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  await checkAsync('a CUSTOMER token is rejected (403), not just anonymous', async () => {
    authBehaviour = { user: { id: 'customer-1' }, error: null };
    profileBehaviour = { id: 'customer-1', role: 'CUSTOMER', is_active: true };
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'valid-but-customer', body: { secret: 'x' } });
    assert.strictEqual(res.status, 403, 'a non-admin role must be refused');
  });

  await checkAsync('an INACTIVE admin is rejected (fail-closed)', async () => {
    authBehaviour = { user: { id: 'admin-1' }, error: null };
    profileBehaviour = { id: 'admin-1', role: 'ADMIN', is_active: false };
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'inactive-admin', body: { secret: 'x' } });
    assert.strictEqual(res.status, 403, 'a deactivated admin must be refused');
  });

  // ── Test 1.2 — purge secret protection ────────────────────────────────────
  console.log('\n=== Test 1.2: PURGE SECRET PROTECTION ===');

  // A verified admin, so the request reaches the secret check.
  const asAdmin = () => {
    authBehaviour = { user: { id: 'admin-1' }, error: null };
    profileBehaviour = { id: 'admin-1', role: 'ADMIN', is_active: true };
  };

  await checkAsync('a verified admin with NO secret is rejected', async () => {
    // DEBUG_SECRET is set explicitly here rather than inherited from a previous
    // test. Relying on ambient state made this case order-dependent: if an
    // earlier test had left the variable UNSET, the route's fail-closed 503
    // fired instead of the 403 this assertion is about, and the test failed for
    // a reason unrelated to what it claims to check.
    asAdmin();
    process.env.DEBUG_SECRET = 'correct-horse-battery-staple';
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'admin-token', body: {} });
    assert.strictEqual(res.status, 403, 'an absent secret must be refused');
  });

  await checkAsync('the OLD hardcoded fallback secret is rejected', async () => {
    // The exact string that was published in the repository.
    asAdmin();
    process.env.DEBUG_SECRET = 'correct-horse-battery-staple';
    const res = await request(port, 'POST', '/api/admin/purge-bookings', {
      token: 'admin-token',
      body: { secret: 'speedway-dev-only' },
    });
    assert.strictEqual(res.status, 403, "'speedway-dev-only' must no longer work");
    assert.notStrictEqual(res.body?.success, true);
  });

  await checkAsync('a blank secret is rejected', async () => {
    asAdmin();
    process.env.DEBUG_SECRET = 'correct-horse-battery-staple';
    for (const blank of ['', '   ', null, undefined]) {
      const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'admin-token', body: { secret: blank } });
      assert.strictEqual(res.status, 403, `blank secret ${JSON.stringify(blank)} must be refused`);
    }
  });

  await checkAsync('the debug routes no longer ship a default secret either', async () => {
    // The purge route was not the only offender: /api/debug/list-users and
    // /api/debug/fix-account also fell back to the literal 'speedway-dev-only'.
    // fix-account RESETS a user's password, so the published literal was enough
    // to take over any account. No route in the file may carry that fallback.
    assert.ok(
      !/process\.env\.DEBUG_SECRET\s*\|\|/.test(SERVER),
      'no route may fall back to a default DEBUG_SECRET'
    );
  });

  await checkAsync('the account-takeover debug routes are DELETED, not merely guarded', async () => {
    // list-users and fix-account are gone from the deployable server. A guard can
    // be removed or misconfigured later; a route that does not exist cannot be
    // exploited. fix-account reset ANY user's password, so this is the difference
    // between "hard to abuse" and "impossible to abuse".
    assert.ok(
      !/app\.(get|post|patch|delete)\(['"]\/api\/debug\/list-users/.test(SERVER),
      'GET /api/debug/list-users must not exist'
    );
    assert.ok(
      !/app\.(get|post|patch|delete)\(['"]\/api\/debug\/fix-account/.test(SERVER),
      'POST /api/debug/fix-account must not exist'
    );
    // And the hardcoded password it wrote must be gone with it.
    assert.ok(
      !/Password123!/.test(SERVER),
      'the fixed debug password must not survive anywhere in the server'
    );
  });

  await checkAsync('the surviving debug user lookup requires an ADMIN session', async () => {
    // /api/debug/user/:email originally had NO authentication at all, so any
    // anonymous caller could resolve an email to its auth id, confirmation state
    // and last sign-in time. It is now gated on requireAdmin.
    const body = routeBody(SERVER, "app.get('/api/debug/user/:email'");
    assert.ok(body !== null, 'the route must still exist');
    assert.ok(/await requireAdmin\(req\)/.test(body), 'it must await requireAdmin');
    assert.ok(/status\(403\)/.test(body), 'and return 403 when the guard fails');
  });

  await checkAsync('an UNSET DEBUG_SECRET disables the endpoint entirely (503)', async () => {
    // FAIL CLOSED: "unconfigured" must not silently mean "configured with a
    // public default" — which is exactly what the old fallback did.
    asAdmin();
    delete process.env.DEBUG_SECRET;
    const res = await request(port, 'POST', '/api/admin/purge-bookings', { token: 'admin-token', body: { secret: 'anything' } });
    assert.strictEqual(res.status, 503, 'an unconfigured secret must disable, not default');
    assert.ok(!res.body?.success);
  });

  await checkAsync('the CORRECT secret + admin succeeds (the route is not simply broken)', async () => {
    // Proves the lockdown rejects the bad and accepts the good, rather than
    // refusing everything.
    asAdmin();
    process.env.DEBUG_SECRET = 'correct-horse-battery-staple';
    const res = await request(port, 'POST', '/api/admin/purge-bookings', {
      token: 'admin-token',
      body: { secret: 'correct-horse-battery-staple' },
    });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    assert.strictEqual(res.body.success, true);
  });

  // ── Test 1.3 — admin-cancel lockdown ──────────────────────────────────────
  console.log('\n=== Test 1.3: ADMIN-CANCEL ROUTE LOCKDOWN ===');

  await checkAsync('a regular CUSTOMER token returns 403 Forbidden', async () => {
    authBehaviour = { user: { id: 'customer-9' }, error: null };
    profileBehaviour = { id: 'customer-9', role: 'CUSTOMER', is_active: true };
    const res = await request(port, 'POST', '/api/bookings/admin-cancel', {
      token: 'customer-token',
      body: { bookingId: 'booking-123', reason: 'No-Show' },
    });
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
    assert.notStrictEqual(res.body?.success, true);
  });

  await checkAsync('anonymous (no token) returns 401/403', async () => {
    authBehaviour = { user: null, error: { message: 'missing' } };
    const res = await request(port, 'POST', '/api/bookings/admin-cancel', { body: { bookingId: 'booking-123' } });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  await checkAsync('a STAFF token is also refused (cancellation is ADMIN-only)', async () => {
    // Deliberate: cancellation is destructive and audit-bearing, so it uses
    // requireAdmin (ADMIN) rather than getLifecycleActor (ADMIN | STAFF).
    authBehaviour = { user: { id: 'staff-1' }, error: null };
    profileBehaviour = { id: 'staff-1', role: 'STAFF', is_active: true };
    const res = await request(port, 'POST', '/api/bookings/admin-cancel', { token: 'staff-token', body: { bookingId: 'b' } });
    assert.strictEqual(res.status, 403, 'STAFF must not cancel bookings');
  });

  await checkAsync('an ADMIN token is accepted', async () => {
    asAdmin();
    const res = await request(port, 'POST', '/api/bookings/admin-cancel', { token: 'admin-token', body: { bookingId: 'b' } });
    assert.strictEqual(res.status, 200);
  });

  // ── Test 1.4 — blocked-slots CRUD lockdown ────────────────────────────────
  console.log('\n=== Test 1.4: BLOCKED-SLOTS CRUD LOCKDOWN ===');

  const anonymous = () => { authBehaviour = { user: null, error: { message: 'missing' } }; };
  const customer = () => {
    authBehaviour = { user: { id: 'customer-3' }, error: null };
    profileBehaviour = { id: 'customer-3', role: 'CUSTOMER', is_active: true };
  };

  await checkAsync('POST without a token is rejected', async () => {
    anonymous();
    const res = await request(port, 'POST', '/api/admin/blocked-slots', { body: { block_date: '2026-01-15' } });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  await checkAsync('PATCH without a token is rejected', async () => {
    anonymous();
    const res = await request(port, 'PATCH', '/api/admin/blocked-slots/abc-123', { body: { start_time: '09:00' } });
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  await checkAsync('DELETE without a token is rejected', async () => {
    anonymous();
    const res = await request(port, 'DELETE', '/api/admin/blocked-slots/abc-123');
    assert.ok([401, 403].includes(res.status), `expected 401/403, got ${res.status}`);
  });

  await checkAsync('all three verbs reject a CUSTOMER token', async () => {
    customer();
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const url = method === 'POST' ? '/api/admin/blocked-slots' : '/api/admin/blocked-slots/abc-123';
      const res = await request(port, method, url, { token: 'customer-token', body: method === 'DELETE' ? undefined : {} });
      assert.strictEqual(res.status, 403, `${method} must refuse a customer`);
    }
  });

  await checkAsync('an ADMIN token is accepted on all three verbs', async () => {
    asAdmin();
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const url = method === 'POST' ? '/api/admin/blocked-slots' : '/api/admin/blocked-slots/abc-123';
      const res = await request(port, method, url, { token: 'admin-token', body: method === 'DELETE' ? undefined : {} });
      assert.strictEqual(res.status, 200, `${method} must allow an admin`);
    }
  });

  server.close();

  // ── STRUCTURAL: the real handlers must wire the same guard ────────────────
  console.log('\n=== STRUCTURAL: the REAL routes are wired to the guard ===');

  const REAL_ROUTES = [
    { route: "app.post('/api/admin/purge-bookings'", name: 'POST /api/admin/purge-bookings' },
    { route: "app.post('/api/bookings/admin-cancel'", name: 'POST /api/bookings/admin-cancel' },
    { route: "app.post('/api/admin/blocked-slots'", name: 'POST /api/admin/blocked-slots' },
    { route: "app.patch('/api/admin/blocked-slots/:id'", name: 'PATCH /api/admin/blocked-slots/:id' },
    { route: "app.delete('/api/admin/blocked-slots/:id'", name: 'DELETE /api/admin/blocked-slots/:id' },
  ];

  for (const { route, name } of REAL_ROUTES) {
    check(`${name} calls requireAdmin and returns 403`, () => {
      const body = routeBody(SERVER, route);
      assert.ok(body !== null, `${name} must exist in server.js`);
      assert.ok(/await requireAdmin\(req\)/.test(body), `${name} must await requireAdmin`);
      assert.ok(/status\(403\)/.test(body), `${name} must return 403 when the guard fails`);
    });
  }

  check('the purge route has NO hardcoded secret fallback', () => {
    // The exact defect: `process.env.DEBUG_SECRET || 'speedway-dev-only'`.
    assert.ok(
      !/process\.env\.DEBUG_SECRET\s*\|\|\s*'[^']+'/.test(SERVER),
      "a fallback literal would let the public repo's value authorise a full wipe"
    );
  });

  check('the purge route fails closed when DEBUG_SECRET is unset', () => {
    const body = routeBody(SERVER, "app.post('/api/admin/purge-bookings'");
    assert.ok(/if \(!configuredSecret\)/.test(body), 'an unset secret must disable the endpoint');
    assert.ok(/status\(503\)/.test(body), 'and must report 503, not proceed');
  });

  check('the purge route keeps the secret as a SECOND factor, not the only one', () => {
    const body = routeBody(SERVER, "app.post('/api/admin/purge-bookings'");
    const guardPos = body.indexOf('await requireAdmin(req)');
    const secretPos = body.indexOf('const configuredSecret');
    assert.ok(guardPos !== -1 && secretPos !== -1, 'both factors must be present');
    assert.ok(guardPos < secretPos, 'authentication must be evaluated BEFORE the secret');
  });

  check('admin-cancel no longer hardcodes the audit actor', () => {
    // It previously wrote `actor_name: 'ADMIN'` for every caller, so an
    // anonymous cancellation was indistinguishable from a real admin's.
    //
    // Comments are stripped first: the handler deliberately explains the old
    // behaviour, quoting the very string this assertion forbids.
    const body = stripComments(routeBody(SERVER, "app.post('/api/bookings/admin-cancel'"));
    assert.ok(/actor_name: admin\.profile/.test(body), 'the audit actor must be the verified admin');
    assert.ok(!/actor_name: 'ADMIN'/.test(body), "a hardcoded 'ADMIN' actor destroys the audit trail");
  });

  check('blocked-slots attributes the block to the verified admin', () => {
    const body = routeBody(SERVER, "app.post('/api/admin/blocked-slots'");
    assert.ok(/const createdBy = admin\.profile\?\.id/.test(body), 'created_by must come from the JWT');
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();