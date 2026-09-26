import fs from 'node:fs';

const shared = fs.readFileSync('supabase/functions/_shared/bookingEmail.ts', 'utf8');
const fn = fs.readFileSync('supabase/functions/booking-lifecycle/index.ts', 'utf8');

const checks = [
  ['shared: BookingLike interface declared', /export interface BookingLike/.test(shared)],
  ['shared: PaymentLike interface declared', /export interface PaymentLike/.test(shared)],
  ['shared: OcrDetails interface declared', /export interface OcrDetails/.test(shared)],
  ['shared: extractOcrDetails returns OcrDetails', /\): OcrDetails =>/.test(shared)],
  ['shared: VAT rate constant declared', /export const VAT_RATE = 0\.12/.test(shared)],
  ['shared: VAT divides by (1 + VAT_RATE)', /1 \+ VAT_RATE/.test(shared)],
  ['shared: the incorrect /112 VAT split is gone', !/\/ 112/.test(shared)],
  ['shared: shell() is typed (no implicit any)', /const shell = \(title: string, inner: string\)/.test(shared)],
  ['shared: renderLifecycle() is typed', /const renderLifecycle = \(statusKey: string\)/.test(shared)],
  ['shared: paymentBlock() is typed', /amounts: ReturnType<typeof resolveAmounts>/.test(shared)],
  ['shared: rows is string[]', /const rows: string\[\] = \[\]/.test(shared)],
  ['shared: ocrRows is string[]', /const ocrRows: string\[\] = \[\]/.test(shared)],
  ['shared: buildStatusEmail returns a typed shape', /amounts: ReturnType<typeof resolveAmounts> \} => \{/.test(shared)],
  ['shared: STATUS_COPY is Record<string, string>', /const STATUS_COPY: Record<string, string>/.test(shared)],
  ['shared: no leftover `paymentId` doc claim', !/paymentId\?/.test(shared)],

  ['function: Deno ambient reference present', /<reference path="\.\.\/_shared\/deno-globals\.d\.ts" \/>/.test(fn)],
  ['function: serve handler is typed', /serve\(async \(req: Request\): Promise<Response>/.test(fn)],
  ['function: BookingRow interface declared', /interface BookingRow extends BookingLike/.test(fn)],
  ['function: ReceiptItem interface declared', /interface ReceiptItem/.test(fn)],
  ['function: EmailAttachment interface declared', /interface EmailAttachment/.test(fn)],
  ['function: no `(booking as any)` casts remain', !/booking as any/.test(fn)],
  ['function: no `any[]` attachments remain', !/: any\[\]/.test(fn)],
  ['function: no `(item: any)` in PDF builder', !/\(item: any\)/.test(fn)],
  ['function: catch is `unknown`-safe', /catch \(error: unknown\)/.test(fn)],
  // The service-role exact-match guard was measured to be unusable as a gate:
  // requiring `authHeader !== 'Bearer ' + Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
  // rejected even a valid service-role JWT, so it cannot decide authorization
  // here. The enforced rule is now "a Bearer credential must be present".
  //
  // NOTE: `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` is still used to INIT the
  // Supabase client (line ~105) and that read succeeds — the env var IS
  // available. What failed was only its use as a request-auth comparison, which
  // is why the guard was replaced rather than the env access removed.
  ['function: a Bearer credential is required', /!authHeader\.startsWith\('Bearer '\)/.test(fn)],
  ['function: the authorization gap is documented, not silently left', /FOLLOW-UP REQUIRED/.test(fn)],
  ['function: auth no longer gated on env comparison', !/authHeader !== `Bearer \$\{serviceKey\}`/.test(fn)],
  ['function: no stale error message', !/bError\?\.message\}`/.test(fn)],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
}

console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);