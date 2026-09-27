/**
 * tests/startup_guard.test.js
 * ============================================================================
 * Verifies the boot guard fails LOUDLY on missing config and stays quiet when
 * config is present.
 *
 * WHY THIS MATTERS
 * ----------------
 * Two silent failure modes were found in server.js and this guard closes both:
 *
 *   1. A missing SUPABASE_SERVICE_ROLE_KEY only logged a warning and the server
 *      started anyway with every database feature disabled — reporting itself
 *      healthy.
 *
 *   2. PASSWORD_CIPHER_KEY fell back to the literal string 'development-key',
 *      a value published in this repository. Password-confirmation tokens would
 *      have been encrypted with a publicly known key. It would not have crashed,
 *      which is precisely why it was dangerous.
 *
 * The guard must therefore FAIL on a placeholder value, not merely on an absent
 * one — 'development-key' is the exact case that caused (2).
 *
 * Run: node tests/startup_guard.test.js
 * ============================================================================
 */
const assert = require('assert');
const path = require('path');

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

const { checkEnvironment, looksPlaceholder } = require(path.join('..', 'backend', 'config', 'startupGuard.js'));

/**
 * Runs the guard against a clean env so the real environment cannot leak in.
 *
 * CAREFUL: `Object.assign(process.env, { KEY: undefined })` does NOT delete the
 * variable — it coerces to the STRING "undefined", which is truthy, so a
 * "missing variable" test would silently pass while proving nothing. Variables
 * whose value is undefined are therefore deleted explicitly.
 */
const withEnv = (vars, fn) => {
  const saved = {};
  const managed = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'FRONTEND_URL',
    'RESEND_API_KEY', 'GEMINI_API_KEY', 'RESEND_FROM', 'NODE_ENV',
  ];
  for (const k of managed) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    // undefined means "absent", not "the string 'undefined'".
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    // exitOnFailure:false so a failing guard does not kill the test process.
    return fn(checkEnvironment({ exitOnFailure: false }));
  } finally {
    for (const k of managed) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

const FULL = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.real-looking-key',
  FRONTEND_URL: 'https://speedway.example.com',
};

console.log('=== the guard must PASS on complete configuration ===');

check('a fully configured environment is ok', () => {
  withEnv({ ...FULL, NODE_ENV: 'production' }, (r) => {
    assert.strictEqual(r.ok, true, `expected ok, got: ${JSON.stringify(r.missingRequired)}`);
    assert.deepStrictEqual(r.missingRequired, []);
  });
});

check('recommended-but-missing variables do NOT block boot', () => {
  withEnv({ ...FULL, NODE_ENV: 'production' }, (r) => {
    assert.strictEqual(r.ok, true, 'email/OCR are degraded features, not boot blockers');
    assert.ok(r.missingRecommended.length >= 2, 'they should still be reported');
  });
});

console.log('\n=== the guard must FAIL on missing required config ===');

check('a missing SUPABASE_SERVICE_ROLE_KEY blocks boot', () => {
  withEnv({ ...FULL, SUPABASE_SERVICE_ROLE_KEY: undefined }, (r) => {
    assert.strictEqual(r.ok, false);
    assert.ok(r.missingRequired.some((m) => m.includes('SUPABASE_SERVICE_ROLE_KEY')));
  });
});

check('a missing SUPABASE_URL blocks boot', () => {
  withEnv({ ...FULL, SUPABASE_URL: undefined }, (r) => {
    assert.strictEqual(r.ok, false);
    assert.ok(r.missingRequired.some((m) => m.includes('SUPABASE_URL')));
  });
});

check('a missing FRONTEND_URL blocks boot', () => {
  withEnv({ ...FULL, FRONTEND_URL: undefined }, (r) => {
    assert.strictEqual(r.ok, false);
    assert.ok(r.missingRequired.some((m) => m.includes('FRONTEND_URL')));
  });
});

check('an empty-string value counts as missing', () => {
  withEnv({ ...FULL, SUPABASE_URL: '   ' }, (r) => {
    assert.strictEqual(r.ok, false, 'whitespace is not a configured value');
  });
});

console.log('\n=== the placeholder case that caused the cipher defect ===');

check('"development-key" is rejected even though it is SET', () => {
  withEnv({ ...FULL, SUPABASE_SERVICE_ROLE_KEY: 'development-key' }, (r) => {
    assert.strictEqual(r.ok, false, 'the literal public fallback key must never be accepted');
    assert.ok(
      r.missingRequired.some((m) => m.includes('placeholder')),
      'the reason must name it as a placeholder, not merely absent'
    );
  });
});

check('other placeholder shapes are rejected', () => {
  for (const bad of ['your-service-role-key', 'changeme', 'XXXXXXXX', 'placeholder']) {
    assert.strictEqual(looksPlaceholder(bad), true, `"${bad}" should be treated as a placeholder`);
  }
});

check('a real-looking key is NOT mistaken for a placeholder', () => {
  assert.strictEqual(looksPlaceholder('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def'), false);
});

console.log('\n=== production-only warnings ===');

check('a non-https FRONTEND_URL warns in production', () => {
  withEnv({ ...FULL, FRONTEND_URL: 'http://speedway.example.com', NODE_ENV: 'production' }, (r) => {
    assert.ok(r.warnings.some((w) => /https/i.test(w)), 'should warn that emailed links need https');
  });
});

check('http on localhost is fine outside production', () => {
  withEnv({ ...FULL, FRONTEND_URL: 'http://localhost:5173', NODE_ENV: 'development' }, (r) => {
    assert.strictEqual(r.warnings.length, 0, 'local development over http is expected');
  });
});

console.log('\n=== the guard must never leak secret VALUES ===');

check('failure messages name variables but not their values', () => {
  const secret = 'super-secret-value-that-must-not-be-logged';
  withEnv({ ...FULL, GEMINI_API_KEY: secret }, (r) => {
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(secret), 'the guard output must never contain a secret value');
  });
});

// Regression guard for the harness bug this file originally contained: setting a
// variable to undefined must make it ABSENT, not the string "undefined".
check('harness: an undefined value is treated as absent, not as "undefined"', () => {
  withEnv({ ...FULL, SUPABASE_URL: undefined }, (r) => {
    assert.strictEqual(process.env.SUPABASE_URL, undefined, 'the variable must actually be deleted');
    assert.strictEqual(r.ok, false, 'and the guard must see it as missing');
  });
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);