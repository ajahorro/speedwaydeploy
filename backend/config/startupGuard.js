/**
 * backend/config/startupGuard.js
 * ============================================================================
 * Fail LOUDLY at boot when required configuration is missing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Deploying this server to a host (Render) makes every previously-local
 * assumption load-bearing. Two silent failure modes were found in server.js:
 *
 *   1. A missing SUPABASE_SERVICE_ROLE_KEY only logged a warning, and the server
 *      started anyway with every database feature disabled. The process looked
 *      healthy and the health check returned 200, so the deploy appeared
 *      successful while bookings, emails and admin actions were all dead.
 *
 *   2. PASSWORD_CIPHER_KEY was derived as:
 *
 *          crypto.createHash('sha256')
 *            .update(process.env.SUPABASE_SERVICE_ROLE_KEY || 'development-key')
 *
 *      A missing key therefore fell back to a LITERAL, PUBLIC string. Every
 *      password-confirmation token would be encrypted with a key that is in the
 *      repository — decryptable by anyone. It would not crash; it would just be
 *      insecure, which is the worst kind of failure to ship.
 *
 * A server that cannot do its job should refuse to start, not run in a degraded
 * state that reports itself as healthy. Failing at boot surfaces the problem in
 * the deploy log where it can be fixed, instead of in production where it
 * manifests as "the site is broken and nothing says why".
 *
 * TIERS
 * -----
 *   REQUIRED  — the server cannot function correctly without it. Refuse to boot.
 *   RECOMMENDED — a feature degrades without it. Warn loudly, still boot, and
 *                 report the degradation through /api/health.
 *
 * Deliberately NOT exiting on RECOMMENDED: a receipt-scanning outage should not
 * take down booking submission for the whole shop.
 * ============================================================================
 */

/** Configuration the server cannot do its job without. */
const REQUIRED = [
  {
    key: 'SUPABASE_URL',
    why: 'every database call, and the Supabase admin client',
  },
  {
    key: 'SUPABASE_SERVICE_ROLE_KEY',
    why: 'the admin client (RLS-bypassing reads/writes) AND the password-confirmation cipher key. Without it the cipher silently falls back to a literal public string.',
  },
  {
    key: 'FRONTEND_URL',
    why: 'every emailed link (confirmation, password reset, invites). Without it links point at localhost and are unusable by the recipient.',
  },
];

/** Configuration that degrades a feature rather than breaking the server. */
const RECOMMENDED = [
  {
    key: 'RESEND_API_KEY',
    why: 'no transactional email is delivered (booking confirmations, receipts, invites, password resets)',
  },
  {
    key: 'RESEND_FROM',
    why: 'emails send from the placeholder sender, which most providers reject or spam-fold',
  },
];

/** Values that look set but are not usable in production. */
const PLACEHOLDER_PATTERNS = [
  /^development-key$/i,
  /^your[-_]?/i,
  /^changeme$/i,
  /^xxx+$/i,
  /^<.*>$/,
  /^placeholder/i,
];

const looksPlaceholder = (value) =>
  PLACEHOLDER_PATTERNS.some((re) => re.test(String(value || '').trim()));

/**
 * Validate the environment.
 *
 * @param {object} [options]
 * @param {boolean} [options.exitOnFailure=true] call process.exit(1) on a
 *   REQUIRED failure. Tests pass false so they can assert without dying.
 * @returns {{ok:boolean, missingRequired:string[], missingRecommended:string[], warnings:string[]}}
 */
const checkEnvironment = ({ exitOnFailure = true } = {}) => {
  const missingRequired = [];
  const missingRecommended = [];
  const warnings = [];

  for (const { key, why } of REQUIRED) {
    const value = process.env[key];
    if (!value || !String(value).trim()) {
      missingRequired.push(`${key} — ${why}`);
      continue;
    }
    if (looksPlaceholder(value)) {
      // Set, but to something that cannot work. This is the 'development-key'
      // case: it passes a naive presence check while being unsafe.
      missingRequired.push(`${key} — set, but to a placeholder value ("${String(value).slice(0, 24)}"). ${why}`);
    }
  }

  for (const { key, why } of RECOMMENDED) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      missingRecommended.push(`${key} — ${why}`);
    }
  }

  // A non-https FRONTEND_URL in production sends customers a link they may not
  // be able to open, and signals the variable was copied from a dev .env.
  const frontendUrl = process.env.FRONTEND_URL || '';
  if (frontendUrl && process.env.NODE_ENV === 'production' && !frontendUrl.startsWith('https://')) {
    warnings.push(`FRONTEND_URL is "${frontendUrl}" but NODE_ENV=production — emailed links should use https.`);
  }

  const ok = missingRequired.length === 0;

  if (missingRequired.length) {
    console.error('\n' + '='.repeat(72));
    console.error('FATAL: the server is missing required configuration.');
    console.error('='.repeat(72));
    for (const item of missingRequired) console.error(`  ✗ ${item}`);
    console.error('\nSet these in your host\'s environment (Render: Dashboard > your');
    console.error('service > Environment), then redeploy. The server refuses to start');
    console.error('without them because it would otherwise run in a degraded state that');
    console.error('reports itself as healthy.\n');

    if (exitOnFailure) process.exit(1);
  }

  if (missingRecommended.length) {
    console.warn('\n' + '-'.repeat(72));
    console.warn('WARNING: optional configuration is missing. The server will start,');
    console.warn('but these features are degraded:');
    for (const item of missingRecommended) console.warn(`  ! ${item}`);
    console.warn('-'.repeat(72) + '\n');
  }

  for (const w of warnings) console.warn(`⚠️  ${w}`);

  if (ok) {
    console.log('✅ Startup configuration validated (required variables present).');
  }

  return { ok, missingRequired, missingRecommended, warnings };
};

module.exports = { checkEnvironment, REQUIRED, RECOMMENDED, looksPlaceholder };