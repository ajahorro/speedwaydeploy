/**
 * catalog-actions.test.js
 * ============================================================================
 * Behavioural tests for the Business Hub service-catalog action gates.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Admin Business Hub is behind ProtectedRoute + an ADMIN profile, so it
 * cannot be driven in a headless test without mocking Supabase's whole session
 * bootstrap. But the logic that actually regressed is PURE: which button renders
 * on a given row, which rows the master Archive/Restore buttons target, and
 * whether anything is written before a confirmation is accepted.
 *
 * The source of truth is the shipped component. Rather than re-implement the
 * rules (which would let the test pass while the app drifts), this extracts the
 * predicates from `BusinessHub.jsx` and asserts them, and separately asserts the
 * structural rules on the component's own source text:
 *
 *   1. Per-row actions are behind `serviceEditMode`.
 *   2. Archive and Restore are distinct controls with distinct handlers.
 *   3. Archive targets only active rows; Restore targets only archived rows.
 *   4. Every mutating handler routes through the confirmation gate.
 *
 * Run: node tests/catalog_actions.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HUB = path.join(ROOT, 'frontend/src/pages/Admin/BusinessHub.jsx');
const src = fs.readFileSync(HUB, 'utf8');

// Comments that DOCUMENT a removed thing must not satisfy a "is it gone" check.
// Every negative assertion below runs against the code with comments stripped.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

let passed = 0;
let failed = 0;

const check = (label, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

// ── The predicates under test, mirroring the component's own ────────────────
const isArchivedService = (s) => s?.is_active === false || s?.archived === true;

// These MUST match the component. Assert that they do (below), then use them.
const archiveTargets = (rows) => rows.filter((s) => !isArchivedService(s));
const restoreTargets = (rows) => rows.filter(isArchivedService);

console.log('\n== 1. archive/restore target sets are disjoint and correct ==\n');

const ACTIVE = { id: 'a', name: 'Active Wash', is_active: true, archived: false };
const ARCHIVED = { id: 'b', name: 'Archived Wax', is_active: false, archived: true };
const ARCHIVED_FLAG_ONLY = { id: 'c', name: 'Flag Only', is_active: true, archived: true };
const ACTIVE_FLAG_ONLY = { id: 'd', name: 'Inactive Only', is_active: false, archived: false };
const MIXED = [ACTIVE, ARCHIVED, ARCHIVED_FLAG_ONLY, ACTIVE_FLAG_ONLY];

check('Archive selects only active rows', JSON.stringify(archiveTargets(MIXED).map((s) => s.id)) === JSON.stringify(['a']));
check('Restore selects only archived rows', JSON.stringify(restoreTargets(MIXED).map((s) => s.id)) === JSON.stringify(['b', 'c', 'd']));
check(
  'a row is never in both sets',
  archiveTargets(MIXED).every((s) => !restoreTargets(MIXED).includes(s))
);
check('the two sets cover the whole selection', archiveTargets(MIXED).length + restoreTargets(MIXED).length === MIXED.length);
check('`archived: true` alone counts as archived', isArchivedService(ARCHIVED_FLAG_ONLY) === true);
check('`is_active: false` alone counts as archived', isArchivedService(ACTIVE_FLAG_ONLY) === true);
check('an active row is not archived', isArchivedService(ACTIVE) === false);

console.log('\n== 2. component predicates match this test ==\n');

const componentPredicate = src.match(/const isArchivedService = \(service\) =>([^;]+);/);
check('component defines isArchivedService', Boolean(componentPredicate));
if (componentPredicate) {
  const body = componentPredicate[1];
  check('component predicate checks is_active === false', /is_active === false/.test(body));
  check('component predicate checks archived === true', /archived === true/.test(body));
}

check('archiveTargets in component inverts the predicate', /archiveTargets = useMemo\(\s*\(\) => selectedServiceRows\.filter\(\(s\) => !\(s\.is_active === false \|\| s\.archived === true\)\)/.test(code));
check('restoreTargets in component uses the predicate', /restoreTargets = useMemo\(\s*\(\) => selectedServiceRows\.filter\(\(s\) => s\.is_active === false \|\| s\.archived === true\)/.test(code));

console.log('\n== 3. per-row actions are gated behind master edit mode ==\n');

// Find the Actions <td> block and assert the per-row buttons live inside a
// `serviceEditMode &&` guard, so nothing is actionable until the master Edit
// button is pressed.
const actionsCell = src.slice(src.indexOf('justifyContent: \'flex-end\''));
const guardIdx = actionsCell.indexOf('serviceEditMode &&');
check('per-row action cell is guarded by serviceEditMode', guardIdx > -1);
check('the Edit button is inside that guard', actionsCell.indexOf('>Edit<') > guardIdx);
check('the Delete button is inside that guard', actionsCell.indexOf('requestDeleteService(service)') > guardIdx);
check(
  'the old ungated `!isMultiSelect` Edit button is gone',
  !/!isMultiSelect/.test(src)
);

console.log('\n== 4. Archive and Restore are distinct controls ==\n');

check('a distinct requestArchiveService exists', /const requestArchiveService = \(service\) =>/.test(src));
check('a distinct requestRestoreService exists', /const requestRestoreService = \(service\) =>/.test(src));
check('a distinct commitArchiveServices exists', /const commitArchiveServices = async/.test(src));
check('a distinct commitRestoreServices exists', /const commitRestoreServices = async/.test(src));
check('the old combined toggle is gone', !/handleArchiveRestoreService/.test(code));
check('the old combined batch function is gone', !/const batchArchiveServices/.test(code));

// Archive / Restore handlers must not be interchangeable: each must refuse the
// wrong state, so a mis-click cannot flip a row the admin did not intend.
check(
  'requestArchiveService refuses an already-archived row',
  /const requestArchiveService = \(service\) => \{\s*if \(!service \|\| isArchivedService\(service\)\) return;/.test(code)
);
check(
  'requestRestoreService refuses an active row',
  /const requestRestoreService = \(service\) => \{\s*if \(!service \|\| !isArchivedService\(service\)\) return;/.test(code)
);

console.log('\n== 5. master buttons are labelled distinctly and target their own set ==\n');

check('master Archive button calls requestBatchArchive', /onClick=\{requestBatchArchive\}/.test(src));
check('master Restore button calls requestBatchRestore', /onClick=\{requestBatchRestore\}/.test(src));
check('master Archive is disabled with no archive targets', /disabled=\{!archiveTargets\.length\}/.test(src));
check('master Restore is disabled with no restore targets', /disabled=\{!restoreTargets\.length\}/.test(src));
check('no "Archive/Restore" combined label remains', !/Archive\/Restore</.test(code));

console.log('\n== 6. every mutation goes through a confirmation ==\n');

check('a shared confirmation gate exists', /const confirmCatalogAction = \(/.test(src));
check('the gate opens a modal', /openModal\(\{/.test(src) && /onConfirm:/.test(src));
check('per-row archive asks for confirmation', /const requestArchiveService[\s\S]*?confirmCatalogAction\(\{/.test(src));
check('per-row restore asks for confirmation', /const requestRestoreService[\s\S]*?confirmCatalogAction\(\{/.test(src));
check('per-row delete asks for confirmation', /const requestDeleteService[\s\S]*?confirmCatalogAction\(\{/.test(src));
check('batch archive asks for confirmation', /const requestBatchArchive[\s\S]*?confirmCatalogAction\(\{/.test(src));
check('batch restore asks for confirmation', /const requestBatchRestore[\s\S]*?confirmCatalogAction\(\{/.test(src));
check('batch delete asks for confirmation', /const requestBatchDelete[\s\S]*?confirmCatalogAction\(\{/.test(src));

// The commit functions must be reachable ONLY from the gate, not wired to a
// button directly — otherwise a click could write without confirming.
check(
  'commit functions are not wired directly to any onClick',
  !/onClick=\{commitArchiveServices\}|onClick=\{commitRestoreServices\}|onClick=\{commitDeleteService\}/.test(code)
);
check(
  'the legacy un-confirmed delete modal is gone',
  !/pendingDelete/.test(code)
);

console.log('\n== 7. no accidental injection of markup/attributes ==\n');

// React escapes text by default; the risk is raw HTML sinks.
const FORBIDDEN = [
  ['dangerouslySetInnerHTML', /dangerouslySetInnerHTML/],
  ['eval(', /[^.\w]eval\s*\(/],
  ['new Function', /new Function\s*\(/],
  ['document.write', /document\.write/],
  ['innerHTML assignment', /\.innerHTML\s*=/],
  ['javascript: URL', /javascript:/i],
];
FORBIDDEN.forEach(([label, re]) => {
  check(`no ${label} in BusinessHub.jsx`, !re.test(code));
});

// The new confirmations interpolate service NAMES into a modal message. Those
// must be plain strings in the component (React escapes on render) and must not
// be concatenated into HTML.
check(
  'service names are interpolated into plain strings, not HTML',
  !/\$\{service\.name\}[^`]*<\w/.test(code)
);

console.log(`\n${failed === 0 ? 'ALL PASSED' : 'FAILURES PRESENT'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
