/**
 * tests/toast_manager.test.js
 * ============================================================================
 * Regression tests for the toast dedupe / cap / priority rules.
 *
 * THE REPORTED DEFECT
 * -------------------
 * One walk-in booking produced THREE toasts at the same instant, from three
 * unrelated modules:
 *
 *   "Booking submitted successfully!"       (CustomerBookAppointment)
 *   "Walk-in booking created and confirmed."(AdminWalkInWizard)
 *   "jamesvillanueva119 booked a service…"  (AdminLayout Realtime listener)
 *
 * They stacked on top of each other, and the Realtime alert (top-right, 8s)
 * painted over the Official Receipt modal the user was reading.
 *
 * No call site can coordinate this — each legitimately believes it is the only
 * notifier. The rules therefore live in utils/toastManager, and this file pins
 * them down:
 *
 *   1. DEDUPE   an identical live message is refreshed, never duplicated
 *   2. CAP      at most MAX_VISIBLE toasts on screen; oldest evicted first
 *   3. PRIORITY a background toast never renders while a modal is open
 *
 * The rules are exercised through `createToastQueue(stubEngine)`. That is the
 * whole point of the factory: it makes the decisions testable WITHOUT a
 * module-resolution hack. (Patching `Module._load` does not intercept an ES
 * `import` of a CJS package, so a test built that way passes while observing
 * nothing — which is exactly the trap this harness avoids.)
 *
 * Run: node tests/toast_manager.test.js
 * ============================================================================
 */
const assert = require('assert');

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

(async () => {
  const { createToastQueue, MAX_VISIBLE } = await import('../frontend/src/utils/toastManager.js');

  // ── Recording stub engine ─────────────────────────────────────────────────
  const spawned = [];
  const dismissed = [];
  let seq = 0;

  const variant = (kind) => (message, options = {}) => {
    const id = options.id ?? `${kind}-${++seq}`;
    spawned.push({ id, kind, message, options });
    return id;
  };

  const stubEngine = {
    success: variant('success'),
    error: variant('error'),
    loading: variant('loading'),
    default: variant('default'),
    dismiss: (id) => { dismissed.push(id); },
  };

  const queue = createToastQueue(stubEngine);
  const liveCount = () => queue.__live().length;

  // Harness guard: prove the queue actually reaches the stub. Without this the
  // suite could pass while observing nothing at all.
  check('harness: the queue renders through the injected engine', () => {
    const before = spawned.length;
    queue.success('__harness__');
    assert.ok(spawned.length > before, 'no spawn reached the stub — assertions would be vacuous');
    queue.dismissAll();
    spawned.length = 0;
  });

  console.log('\n=== RULE 2: the cap holds at MAX_VISIBLE ===');

  check('MAX_VISIBLE is 2 (a 3-toast burst becomes at most 2)', () => {
    assert.strictEqual(MAX_VISIBLE, 2);
  });

  check('the reported 3-toast burst leaves at most 2 on screen', () => {
    queue.dismissAll();
    spawned.length = 0; dismissed.length = 0;

    // Exactly the reported sequence.
    queue.success('Booking submitted successfully!');
    queue.success('Walk-in booking created and confirmed.');
    queue.background('jamesvillanueva119 booked a service for ₱2,500.00.');

    assert.ok(liveCount() <= MAX_VISIBLE, `expected <= ${MAX_VISIBLE} live, got ${liveCount()}`);
    assert.strictEqual(dismissed.length, 1, 'the oldest toast must be evicted to make room');
  });

  check('the NEWEST toast survives (it is the most relevant)', () => {
    const messages = queue.__live().map((t) => t.message);
    assert.ok(
      messages.some((m) => String(m).includes('booked a service')),
      'the newest (Realtime alert) must still be present'
    );
    assert.ok(
      !messages.some((m) => String(m).includes('Booking submitted successfully')),
      'the oldest must have been sacrificed'
    );
  });

  check('a burst of five never exceeds the cap', () => {
    queue.dismissAll();
    for (let i = 1; i <= 5; i += 1) queue.success(`message ${i}`);
    assert.strictEqual(liveCount(), MAX_VISIBLE);
  });

  console.log('\n=== RULE 1: dedupe ===');

  check('an identical message is NOT spawned twice', () => {
    queue.dismissAll();
    spawned.length = 0;

    queue.success('Vehicle Updated');
    queue.success('Vehicle Updated');

    // A refresh DOES re-emit to the engine — that is how react-hot-toast restarts
    // the timer. What must NOT happen is a second CARD: one distinct id, one live
    // entry. Asserting on the spawn count would be wrong here.
    const distinctIds = new Set(spawned.map((s) => s.id));
    assert.strictEqual(distinctIds.size, 1, 'the duplicate must not get its own id');
    assert.strictEqual(liveCount(), 1, 'the duplicate must not add a second card');
  });

  check('the duplicate REUSES the original id (refreshes the timer)', () => {
    queue.dismissAll();
    spawned.length = 0;

    const first = queue.success('Profile updated');
    queue.success('Profile updated');

    assert.strictEqual(spawned.length, 2, 'the refresh re-emits to restart the timer');
    assert.strictEqual(spawned[0].options.id, undefined, 'the first spawn lets the engine mint an id');
    assert.strictEqual(spawned[1].options.id, first, 'the refresh targets the existing id');
  });

  check('dedupe is case- and whitespace-insensitive', () => {
    queue.dismissAll();
    spawned.length = 0;
    queue.success('Saved');
    queue.success('  saved  ');
    assert.strictEqual(new Set(spawned.map((s) => s.id)).size, 1, 'case/space variants are the same toast');
    assert.strictEqual(liveCount(), 1);
  });

  check('DIFFERENT messages still both appear', () => {
    queue.dismissAll();
    spawned.length = 0;
    queue.success('Booking submitted successfully!');
    queue.success('Walk-in booking created and confirmed.');
    assert.strictEqual(spawned.length, 2, 'distinct messages are distinct toasts');
  });

  check('the same message under a different variant is a different toast', () => {
    queue.dismissAll();
    spawned.length = 0;
    queue.success('Saved');
    queue.error('Saved');
    assert.strictEqual(spawned.length, 2, 'success and error are not interchangeable');
  });

  check('a render-function toast is NOT deduped against another (no source compare)', () => {
    queue.dismissAll();
    spawned.length = 0;
    const render = (t) => `node-${t.id}`;
    queue.background(render, { dedupeKey: 'booking:A' });
    queue.background(render, { dedupeKey: 'booking:B' });
    assert.strictEqual(spawned.length, 2, 'different dedupeKeys must both render');
  });

  check('the same dedupeKey DOES collapse', () => {
    queue.dismissAll();
    spawned.length = 0;
    const render = (t) => `node-${t.id}`;
    queue.background(render, { dedupeKey: 'booking:A' });
    queue.background(render, { dedupeKey: 'booking:A' });
    assert.strictEqual(new Set(spawned.map((s) => s.id)).size, 1, 'same key = same toast');
    assert.strictEqual(liveCount(), 1);
  });

  check('a render-function toast without a key is never deduped', () => {
    queue.dismissAll();
    spawned.length = 0;
    const render = (t) => `node-${t.id}`;
    queue.background(render);
    queue.background(render);
    assert.strictEqual(spawned.length, 2, 'no key means no dedupe, not a wrong collapse');
  });

  console.log('\n=== RULE 3: background toasts never cover a modal ===');

  // Drain any modal state left by an earlier section so these assertions start
  // from a known counter. Without this a leaked open() makes later background
  // toasts silently suppressed and the failures look like product bugs.
  const resetModalState = () => {
    while (queue.__openModalCount() > 0) queue.notifyModalClosed();
    queue.dismissAll();
    spawned.length = 0;
  };

  check('a background toast is SUPPRESSED while a modal is open', () => {
    resetModalState();
    queue.dismissAll();
    spawned.length = 0;

    queue.notifyModalOpened();
    const result = queue.background('jamesvillanueva119 booked a service for ₱2,500.00.');

    assert.strictEqual(result, null, 'suppressed toasts return null');
    assert.strictEqual(spawned.length, 0, 'nothing may render over the modal');
    assert.strictEqual(liveCount(), 0);
  });

  check('opening a modal clears anything already on screen', () => {
    resetModalState();
    queue.success('Something happened');
    assert.strictEqual(liveCount(), 1);

    queue.notifyModalOpened();
    assert.strictEqual(liveCount(), 0, 'a modal must not be covered by a stale toast');
  });

  check('a FOREGROUND toast still shows while a modal is open (user is waiting)', () => {
    // A modal is open from the previous test — deliberately NOT closed here, so
    // this asserts the foreground/background distinction rather than a clean slate.
    assert.strictEqual(queue.__openModalCount(), 1, 'precondition: one modal is open');
    spawned.length = 0;
    queue.success('Payment Approved & Ledger Synced');
    assert.strictEqual(spawned.length, 1, "the user's own action must still report");
  });

  check('after the modal closes, background toasts resume', () => {
    // Close the modal left open by the previous test, returning to a clean slate.
    queue.notifyModalClosed();
    assert.strictEqual(queue.__openModalCount(), 0, 'no modal open');
    spawned.length = 0;
    queue.background('Another booking arrived.');
    assert.strictEqual(spawned.length, 1, 'ambient alerts resume once the modal is gone');
  });

  check('nested modals: only the LAST close resumes background toasts', () => {
    resetModalState();
    assert.strictEqual(queue.__openModalCount(), 0, 'precondition: clean slate');
    queue.notifyModalOpened();
    queue.notifyModalOpened();
    queue.notifyModalClosed(); // one still open

    spawned.length = 0;
    queue.background('should be suppressed');
    assert.strictEqual(spawned.length, 0, 'one modal is still open');

    queue.notifyModalClosed();
    spawned.length = 0;
    queue.background('now allowed');
    assert.strictEqual(spawned.length, 1, 'all modals closed');
  });

  check('an unbalanced close cannot drive the counter negative', () => {
    resetModalState();
    queue.notifyModalClosed();
    queue.notifyModalClosed();
    assert.strictEqual(queue.__openModalCount(), 0, 'never below zero');
  });

  console.log('\n=== dismiss bookkeeping ===');

  check('dismissAll empties the live set', () => {
    queue.success('a');
    queue.success('b');
    assert.ok(liveCount() > 0);
    queue.dismissAll();
    assert.strictEqual(liveCount(), 0);
  });

  check('dismissing one id removes only that toast', () => {
    queue.dismissAll();
    const id = queue.success('keep me');
    queue.success('drop me');
    queue.dismiss(id);
    assert.deepStrictEqual(queue.__live().map((t) => t.message), ['drop me']);
  });

  check('a dismissed toast can be re-shown (dedupe must not block it forever)', () => {
    queue.dismissAll();
    spawned.length = 0;
    const id = queue.success('Saved');
    queue.dismiss(id);
    queue.success('Saved');
    assert.strictEqual(spawned.length, 2, 'after dismissal the same message is a fresh toast');
  });

  check('the manager is a drop-in for the react-hot-toast surface', () => {
    for (const fn of ['success', 'error', 'loading', 'warning', 'info', 'dismiss', 'background', 'dismissAll']) {
      assert.strictEqual(typeof queue[fn], 'function', `queue.${fn} must exist`);
    }
  });

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();