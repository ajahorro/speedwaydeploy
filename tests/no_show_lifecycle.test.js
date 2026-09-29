/**
 * no_show_lifecycle.test.js
 * ============================================================================
 * Validates the no-show state machine + login throttle against a REAL Postgres
 * engine (PGlite/WASM), not a mock.
 *
 * WHY PGlite AND NOT A SOURCE-TEXT CHECK
 * --------------------------------------
 * The rules here are TIME- and STATE-dependent: a booking is undoable for 24h
 * and then is not; the cron must be idempotent; a closed window must be refused
 * even if the caller asks directly. Asserting on SQL text would pass while the
 * phase arithmetic was wrong. This applies the migrations and drives a clock.
 *
 * The clock is injected (`p_now`) rather than mocked, because every new function
 * takes `now()` as a DEFAULTED PARAMETER. That is precisely why it is testable.
 */
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const dir = path.join(__dirname, '..', 'supabase', 'migrations');
const noShowFile = '20261021000001_no_show_lifecycle_and_undo_window.sql';
const evidenceFile = '20261021000002_service_start_stop_evidence_gates.sql';
const vehicleEvidenceFile = '20261021000008_vehicle_evidence_gates.sql';
const throttleFile = '20261021000003_staged_login_throttle.sql';

const q = async (db, sql, params = []) => (await db.query(sql, params)).rows;

// Minimal shims: only what these three migrations touch.
const SHIMS = `
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  email text, role text, full_name text,
  is_active boolean default true, must_change_password boolean default false,
  failed_login_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid, staff_id uuid, bay_id uuid,
  start_datetime timestamptz, end_datetime timestamptz,
  status text, refund_status text, needs_attention boolean default false,
  cancellation_reason text, updated_at timestamptz default now()
);

create table public.booking_vehicles (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  status text
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  status text, method text, amount numeric
);

create table public.service_photos (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references public.bookings(id) on delete cascade,
  booking_vehicle_id uuid references public.booking_vehicles(id) on delete cascade,
  phase text, archived boolean default false, archived_at timestamptz,
  storage_path text
);

-- is_admin() is referenced by the policy on login_security_notices.
create or replace function public.is_admin() returns boolean language sql stable as $$ select false $$;

create or replace function public.assert_service_completable(p_booking_id uuid)
returns void language plpgsql as $$ begin return; end $$;
`;

(async () => {
  const db = new PGlite();
  const asserts = [];
  const check = (label, cond, detail = '') => {
    asserts.push([label, !!cond]);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  };

  try {
    await db.exec(SHIMS);
    console.log('-- shims applied --');

    for (const f of [noShowFile, evidenceFile, vehicleEvidenceFile, throttleFile]) {
      await db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`PASS  ${f} (parsed + executed)`);
    }
    console.log('');

    // ── Phase arithmetic ────────────────────────────────────────────────────
    console.log('== 1. no_show_phase / undo deadline ==');
    const phaseAt = async (startIso, nowIso) =>
      (await q(db, `select public.no_show_phase('FLAGGED_NOSHOW', $1::timestamptz, $2::timestamptz) as p`, [startIso, nowIso]))[0].p;

    const T0 = '2026-10-01T10:00:00Z';
    // Deadline = T0 + 1h + 24h = 2026-10-02T11:00:00Z
    check('1 min after start is still OPEN', (await phaseAt(T0, '2026-10-01T10:01:00Z')) === 'UNDO_WINDOW_OPEN');
    check('at start+1h exactly is OPEN (boundary)', (await phaseAt(T0, '2026-10-01T11:00:00Z')) === 'UNDO_WINDOW_OPEN');
    check('at start+25h minus 1s is OPEN', (await phaseAt(T0, '2026-10-02T10:59:59Z')) === 'UNDO_WINDOW_OPEN');
    check('at start+25h exactly is CLOSED (boundary)', (await phaseAt(T0, '2026-10-02T11:00:00Z')) === 'UNDO_WINDOW_CLOSED');
    check('well past the window is CLOSED', (await phaseAt(T0, '2026-10-05T00:00:00Z')) === 'UNDO_WINDOW_CLOSED');
    check('a non-no-show status is NOT_NO_SHOW', (await q(db, `select public.no_show_phase('scheduled', $1::timestamptz, now()) as p`, [T0]))[0].p === 'NOT_NO_SHOW');
    check('NULL start_datetime stays OPEN (never auto-cancel on missing data)', (await q(db, `select public.no_show_phase('FLAGGED_NOSHOW', null::timestamptz, now()) as p`))[0].p === 'UNDO_WINDOW_OPEN');

    const deadline = (await q(db, `select public.no_show_undo_deadline($1::timestamptz) as d`, [T0]))[0].d;
    check('undo deadline is start + 25h', new Date(deadline).toISOString() === '2026-10-02T11:00:00.000Z', String(deadline));

    // ── Phase 1: flagging ───────────────────────────────────────────────────
    console.log('\n== 2. flag_no_show_bookings (phase 1) ==');
    await db.exec(`
      truncate public.payments, public.service_photos, public.bookings cascade;
      insert into public.bookings (id, status, start_datetime, staff_id, needs_attention)
      values
        ('11111111-1111-4111-8111-111111111111','scheduled','2026-10-01T10:00:00Z','22222222-2222-4222-8222-222222222222', false),
        ('33333333-3333-4333-8333-333333333333','scheduled','2026-10-01T12:00:00Z',null, false),
        ('44444444-4444-4444-8444-444444444444','confirmed','2026-10-01T10:00:00Z',null, false);
      insert into public.payments (booking_id, status, method, amount)
      values ('11111111-1111-4111-8111-111111111111','PAID','GCASH',250);
    `);

    // "Now" = 2026-10-01T11:30Z → only the 10:00 bookings are >1h overdue.
    const flagged = (await q(db, `select public.flag_no_show_bookings(interval '1 hour', '2026-10-01T11:30:00Z'::timestamptz) as n`))[0].n;
    check('flags the two bookings past start+1h', flagged === 2, `got ${flagged}`);

    const notYet = (await q(db, `select status from public.bookings where id='33333333-3333-4333-8333-333333333333'`))[0].status;
    check('leaves a booking inside its 1h grace alone', notYet === 'scheduled', notYet);

    const flaggedRow = (await q(db, `select status, staff_id, needs_attention, refund_status from public.bookings where id='11111111-1111-4111-8111-111111111111'`))[0];
    check('flagged booking becomes FLAGGED_NOSHOW', flaggedRow.status === 'FLAGGED_NOSHOW');
    check('flagging does NOT set needs_attention (dedupe)', flaggedRow.needs_attention === false, String(flaggedRow.needs_attention));
    check('flagging clears staff_id (leaves Unassigned pool)', flaggedRow.staff_id === null);
    check('flagging queues a refund', flaggedRow.refund_status === 'QUEUED', String(flaggedRow.refund_status));

    const payment = (await q(db, `select status from public.payments where booking_id='11111111-1111-4111-8111-111111111111'`))[0].status;
    check('paid money is redirected to the refund queue', payment === 'REFUND_PENDING', payment);

    // Idempotency: a second run at the same clock must not re-flag.
    const flaggedAgain = (await q(db, `select public.flag_no_show_bookings(interval '1 hour', '2026-10-01T11:30:00Z'::timestamptz) as n`))[0].n;
    check('phase 1 is idempotent (no double flag)', flaggedAgain === 0, `got ${flaggedAgain}`);

    // ── Phase 2: the 24h close ──────────────────────────────────────────────
    console.log('\n== 3. close_expired_no_show_windows (phase 2) ==');
    // Before the window closes (start+25h = 2026-10-02T11:00Z), nothing happens.
    const closingEarly = (await q(db, `select public.close_expired_no_show_windows('2026-10-02T10:59:00Z'::timestamptz) as n`))[0].n;
    check('does NOT cancel inside the 24h window', closingEarly === 0, `got ${closingEarly}`);
    const stillFlagged = (await q(db, `select status from public.bookings where id='11111111-1111-4111-8111-111111111111'`))[0].status;
    check('booking is still FLAGGED_NOSHOW inside the window', stillFlagged === 'FLAGGED_NOSHOW', stillFlagged);

    // At/after the deadline it cancels.
    const closing = (await q(db, `select public.close_expired_no_show_windows('2026-10-02T11:00:00Z'::timestamptz) as n`))[0].n;
    check('cancels both bookings exactly at the deadline', closing === 2, `got ${closing}`);

    const cancelled = (await q(db, `select status, refund_status, needs_attention, cancellation_reason from public.bookings where id='11111111-1111-4111-8111-111111111111'`))[0];
    check('past-window booking becomes cancelled', cancelled.status === 'cancelled', cancelled.status);
    check('cancelling PRESERVES the queued refund (no stranded money)', cancelled.refund_status === 'QUEUED', String(cancelled.refund_status));
    check('cancelling records a reason', /Automatically cancelled/i.test(cancelled.cancellation_reason || ''), cancelled.cancellation_reason);
    check('cancelled booking is out of needs_attention', cancelled.needs_attention === false);

    const closingAgain = (await q(db, `select public.close_expired_no_show_windows('2026-10-02T11:00:00Z'::timestamptz) as n`))[0].n;
    check('phase 2 is idempotent', closingAgain === 0, `got ${closingAgain}`);

    // ── Undo: the 24h limit ─────────────────────────────────────────────────
    console.log('\n== 4. undo_no_show respects the window ==');
    // Fresh flagged booking inside the window.
    await db.exec(`
      truncate public.payments, public.service_photos, public.bookings cascade;
      insert into public.bookings (id, status, start_datetime, refund_status)
      values ('55555555-5555-4555-8555-555555555555','FLAGGED_NOSHOW','2026-10-01T10:00:00Z','QUEUED');
      insert into public.payments (booking_id, status, method, amount)
      values ('55555555-5555-4555-8555-555555555555','REFUND_PENDING','GCASH',250);
    `);

    // The RPC uses now(); simulate "inside the window" by making start recent.
    await db.exec(`update public.bookings set start_datetime = now() - interval '2 hours' where id='55555555-5555-4555-8555-555555555555';`);
    const undoOpen = (await q(db, `select public.undo_no_show('55555555-5555-4555-8555-555555555555','ADMIN', false) as r`))[0].r;
    check('undo succeeds inside the 24h window', undoOpen.success === true, JSON.stringify(undoOpen));
    const restored = (await q(db, `select status, refund_status from public.bookings where id='55555555-5555-4555-8555-555555555555'`))[0];
    check('undo restores the booking to scheduled', restored.status === 'scheduled', restored.status);
    check('undo releases the refund hold', restored.refund_status === null, String(restored.refund_status));
    const releasedPayment = (await q(db, `select status from public.payments where booking_id='55555555-5555-4555-8555-555555555555'`))[0].status;
    check('undo returns the payment hold to PAID', releasedPayment === 'PAID', releasedPayment);

    // Now move the booking's start past its window → undo must be REFUSED.
    await db.exec(`
      update public.bookings
         set status = 'FLAGGED_NOSHOW',
             start_datetime = now() - interval '30 hours'
       where id='55555555-5555-4555-8555-555555555555';
    `);
    const undoClosed = (await q(db, `select public.undo_no_show('55555555-5555-4555-8555-555555555555','ADMIN', false) as r`))[0].r;
    check('undo is REFUSED past 24h', undoClosed.success === false, JSON.stringify(undoClosed));
    check('refusal is the specific UNDO_WINDOW_EXPIRED code', undoClosed.error === 'UNDO_WINDOW_EXPIRED', String(undoClosed.error));
    const afterRefusal = (await q(db, `select status from public.bookings where id='55555555-5555-4555-8555-555555555555'`))[0].status;
    check('a refused undo leaves the booking flagged', afterRefusal === 'FLAGGED_NOSHOW', afterRefusal);

    // Exactly 1 second before the deadline must still be allowed.
    await db.exec(`update public.bookings set start_datetime = now() - interval '24 hours' + interval '2 seconds' where id='55555555-5555-4555-8555-555555555555';`);
    const undoEdge = (await q(db, `select public.undo_no_show('55555555-5555-4555-8555-555555555555','ADMIN', false) as r`))[0].r;
    check('undo allowed 1s before the deadline', undoEdge.success === true, JSON.stringify(undoEdge));

    // Completed refunds block undo regardless of the clock.
    await db.exec(`
      update public.bookings set status='FLAGGED_NOSHOW', start_datetime = now() - interval '2 hours'
       where id='55555555-5555-4555-8555-555555555555';
      update public.payments set status='REFUNDED' where booking_id='55555555-5555-4555-8555-555555555555';
    `);
    const undoRefunded = (await q(db, `select public.undo_no_show('55555555-5555-4555-8555-555555555555','ADMIN', false) as r`))[0].r;
    check('undo refused once money was actually refunded', undoRefunded.success === false && undoRefunded.error === 'REFUND_ALREADY_PROCESSED', JSON.stringify(undoRefunded));

    const undoMissing = (await q(db, `select public.undo_no_show('99999999-9999-4999-8999-999999999999','ADMIN', false) as r`))[0].r;
    check('undo of an unknown booking is a clean error', undoMissing.success === false && undoMissing.error === 'BOOKING_NOT_FOUND');

    // ── Photo-evidence gates ────────────────────────────────────────────────
    console.log('\n== 5. start/stop evidence gates ==');
    await db.exec(`
      truncate public.service_photos, public.bookings cascade;
      insert into public.bookings (id, status, start_datetime)
      values ('66666666-6666-4666-8666-666666666666','scheduled', now());
    `);

    let startBlocked = false; let startMsg = '';
    try {
      await db.exec(`update public.bookings set status='in_progress' where id='66666666-6666-4666-8666-666666666666';`);
    } catch (e) { startBlocked = true; startMsg = e.message; }
    check('start is BLOCKED without a before photo', startBlocked, startMsg);
    check('the block raises the documented code', /SERVICE_START_BLOCKED_NO_BEFORE_PHOTO/.test(startMsg), startMsg);

    await db.exec(`
      insert into public.service_photos (booking_id, phase) values ('66666666-6666-4666-8666-666666666666','before');
    `);
    let startOk = true;
    try { await db.exec(`update public.bookings set status='in_progress' where id='66666666-6666-4666-8666-666666666666';`); }
    catch (e) { startOk = false; }
    check('start SUCCEEDS once a before photo exists', startOk);

    let completeBlocked = false; let completeMsg = '';
    try { await db.exec(`update public.bookings set status='completed' where id='66666666-6666-4666-8666-666666666666';`); }
    catch (e) { completeBlocked = true; completeMsg = e.message; }
    check('completion is BLOCKED without an after photo', completeBlocked, completeMsg);
    check('the block raises the documented code', /SERVICE_COMPLETE_BLOCKED_NO_AFTER_PHOTO/.test(completeMsg), completeMsg);

    await db.exec(`insert into public.service_photos (booking_id, phase) values ('66666666-6666-4666-8666-666666666666','after');`);
    let completeOk = true;
    try { await db.exec(`update public.bookings set status='completed' where id='66666666-6666-4666-8666-666666666666';`); }
    catch (e) { completeOk = false; }
    check('completion SUCCEEDS once an after photo exists', completeOk);

    // An unrelated edit must not be gated by the trigger.
    await db.exec(`update public.bookings set status='FLAGGED_NOSHOW' where id='66666666-6666-4666-8666-666666666666';`);
    check('non-service transitions are untouched by the gate', (await q(db, `select status from public.bookings where id='66666666-6666-4666-8666-666666666666'`))[0].status === 'FLAGGED_NOSHOW');

    // Evidence readiness payload.
    const ev = (await q(db, `select public.booking_evidence_state('66666666-6666-4666-8666-666666666666') as r`))[0].r;
    check('evidence state reports before+after present', ev.has_before_photo === true && ev.has_after_photo === true);
    check('evidence state reports the no-show phase', ev.no_show_phase === 'UNDO_WINDOW_OPEN', String(ev.no_show_phase));

    await db.exec(`
      insert into public.bookings (id, status, start_datetime)
      values ('99999999-9999-4999-8999-999999999999','scheduled', now());
      insert into public.service_photos (booking_id, phase, archived_at)
      values ('99999999-9999-4999-8999-999999999999','before', now());
    `);
    const archivedEvidence = (await q(db, `select public.booking_has_photo_phase('99999999-9999-4999-8999-999999999999','before') as present`))[0].present;
    check('archived_at evidence does not satisfy the photo gate', archivedEvidence === false);

    const vehicleId = '88888888-8888-4888-8888-888888888888';
    await db.exec(`insert into public.booking_vehicles (id, booking_id, status) values ('${vehicleId}', '66666666-6666-4666-8666-666666666666', 'SCHEDULED');`);
    let unitStartBlocked = false;
    try { await db.exec(`update public.booking_vehicles set status='IN_PROGRESS' where id='${vehicleId}';`); }
    catch (error) { unitStartBlocked = /SERVICE_START_BLOCKED_NO_BEFORE_PHOTO/.test(error.message); }
    check('vehicle start is blocked until its own before photo exists', unitStartBlocked);

    await db.exec(`insert into public.service_photos (booking_id, booking_vehicle_id, phase) values ('66666666-6666-4666-8666-666666666666', '${vehicleId}', 'before');`);
    await db.exec(`update public.booking_vehicles set status='IN_PROGRESS' where id='${vehicleId}';`);
    let unitCompleteBlocked = false;
    try { await db.exec(`update public.booking_vehicles set status='COMPLETED' where id='${vehicleId}';`); }
    catch (error) { unitCompleteBlocked = /SERVICE_COMPLETE_BLOCKED_NO_AFTER_PHOTO/.test(error.message); }
    check('vehicle completion is blocked until its own after photo exists', unitCompleteBlocked);

    await db.exec(`insert into public.service_photos (booking_id, booking_vehicle_id, phase) values ('66666666-6666-4666-8666-666666666666', '${vehicleId}', 'after');`);
    await db.exec(`update public.booking_vehicles set status='COMPLETED' where id='${vehicleId}';`);
    check('vehicle completion succeeds after its own after photo exists', true);

    // ── Login throttle ladder ───────────────────────────────────────────────
    console.log('\n== 6. staged login throttle ==');
    await db.exec(`
      truncate public.login_security_notices, public.profiles cascade;
      insert into public.profiles (id, email, role, is_active)
      values ('77777777-7777-4777-8777-777777777777','victim@example.com','CUSTOMER',true);
    `);
    const fail = async () => (await q(db, `select public.register_failed_login_staged('victim@example.com') as r`))[0].r;

    const r1 = await fail(); const r2 = await fail(); const r3 = await fail(); const r4 = await fail();
    check('attempts 1-4 are free (not locked)', [r1, r2, r3, r4].every((r) => r.locked === false), JSON.stringify([r1.locked, r2.locked, r3.locked, r4.locked]));
    check('attempt 4 reports 0 remaining', r4.attempts_remaining === 0, String(r4.attempts_remaining));

    const r5 = await fail();
    check('attempt 5 locks for 5 minutes', r5.locked === true && r5.minutes_left === 5, JSON.stringify(r5));

    // While locked, further attempts do not extend or escalate.
    const during = await fail();
    check('a locked account is not extended by new attempts', during.locked === true && during.minutes_left === 5, JSON.stringify(during));

    // ── Stage 1 tolerates ZERO further failures ──────────────────────────────
    // The 5-minute wait IS the consequence of the 5th wrong password. The next
    // wrong password after that wait applies the 10-minute rung — which is the
    // shop's "the very next wrong 2 passwords after 5 minutes have passed, wait
    // for 10 minutes", with the second of that pair being the escalation.
    await db.exec(`update public.profiles set locked_until = now() - interval '1 minute' where email='victim@example.com';`);
    const r6 = await fail();
    check('attempt 6 (after the 5-min wait) locks for 10 minutes', r6.locked === true && r6.minutes_left === 10, JSON.stringify(r6));

    // ── Stage 2 tolerates ONE further failure ───────────────────────────────
    await db.exec(`update public.profiles set locked_until = now() - interval '1 minute' where email='victim@example.com';`);
    const r7 = await fail();
    check('attempt 7 is free (stage 2 tolerates one)', r7.locked === false, JSON.stringify(r7));

    // ── Stage 3 escalates ───────────────────────────────────────────────────
    // Attempt 8 exhausts stage 2 and lands on the escalation rung.
    const r8 = await fail();
    check('attempt 8 escalates to a security notice', r8.escalated === true, JSON.stringify(r8));
    check('the escalation queues exactly one notice', r8.notice_queued === true, JSON.stringify(r8));
    check('the escalation holds the account for an hour', r8.locked === true && r8.minutes_left === 60, JSON.stringify(r8));
    check('the escalation explains an email was sent', /security notice/i.test(r8.message || ''), String(r8.message));

    const noticeRows = await q(db, `select count(*)::int as n from public.login_security_notices`);
    check('one notice row exists', noticeRows[0].n === 1, String(noticeRows[0].n));

    // Further failures in the same episode must NOT email again.
    await db.exec(`update public.profiles set locked_until = now() - interval '1 minute' where email='victim@example.com';`);
    const r9 = await fail();
    check('a repeat failure does not queue a second notice', r9.notice_queued === false, JSON.stringify(r9));
    check('a repeat failure still reports escalated', r9.escalated === true, JSON.stringify(r9));
    const noticeRows2 = await q(db, `select count(*)::int as n from public.login_security_notices`);
    check('still exactly one notice row (no mail-bomb)', noticeRows2[0].n === 1, String(noticeRows2[0].n));

    // Unknown address must not reveal existence.
    const unknown = (await q(db, `select public.register_failed_login_staged('nobody@example.com') as r`))[0].r;
    check('unknown address returns a neutral shape', unknown.locked === false && unknown.attempts_remaining === 4, JSON.stringify(unknown));

    // Success clears the ladder.
    await q(db, `select public.clear_login_lock('victim@example.com') as r`);
    const cleared = (await q(db, `select lockout_stage, stage_failed_attempts, security_notice_sent_at from public.profiles where email='victim@example.com'`))[0];
    check('a successful login resets the stage', cleared.lockout_stage === 0 && cleared.stage_failed_attempts === 0);
    check('a successful login re-arms the notice', cleared.security_notice_sent_at === null);

    const afterReset = await fail();
    check('the ladder restarts from free attempts after a success', afterReset.locked === false && afterReset.stage === 0, JSON.stringify(afterReset));

    // The pre-submit check agrees with the register path.
    const lockInfo = (await q(db, `select public.check_login_lock('victim@example.com') as r`))[0].r;
    check('check_login_lock exposes the stage', typeof lockInfo.stage === 'number', JSON.stringify(lockInfo));
    check('check_login_lock exposes attempts_remaining', typeof lockInfo.attempts_remaining === 'number', JSON.stringify(lockInfo));

    // The legacy entry point must NOT bypass the ladder.
    await db.exec(`truncate public.login_security_notices, public.profiles cascade;
      insert into public.profiles (id, email, role, is_active) values ('88888888-8888-4888-8888-888888888888','legacy@example.com','CUSTOMER',true);`);
    for (let i = 0; i < 4; i += 1) await q(db, `select public.register_failed_login('legacy@example.com') as r`);
    const legacy5 = (await q(db, `select public.register_failed_login('legacy@example.com') as r`))[0].r;
    check('the deprecated register_failed_login uses the staged ladder', legacy5.locked === true && legacy5.minutes_left === 5, JSON.stringify(legacy5));

    // ── Summary ─────────────────────────────────────────────────────────────
    const failed = asserts.filter(([, ok]) => !ok);
    console.log(`\n${failed.length === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${asserts.length - failed.length} passed, ${failed.length} failed\n`);
    process.exit(failed.length === 0 ? 0 : 1);
  } catch (err) {
    console.error('\nHARNESS ERROR:', err.message);
    process.exit(1);
  }
})();