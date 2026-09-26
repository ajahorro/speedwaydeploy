# Speedway AutoxMoto Alpha Test Summary Report

**Document status:** Execution record / manuscript-ready template
**Test phase:** Alpha
**System under test:** Speedway AutoxMoto
**Planned execution window:** ____________________
**Candidate build / commit:** ____________________
**Staging URL:** ____________________

## 1. Executive Summary

The alpha test is designed to validate customer booking, walk-in registration, authentication and recovery, promo/package pricing, payment verification, refunds/credits, operations, staff execution, messaging, notifications, auditability, authorization, and responsive browser behavior.

At document preparation time, the repository-level automated evidence covers six suites: **103 passed and 0 failed assertions**. This demonstrates that the checked-in migration harness, the pure pricing contract, the financial amount model, the VAT split, the email exactly-once semantics, and the OCR/ledger recognition invariants pass.

It does **not** establish that the deployed staging environment, email relay, OCR provider, storage policies, realtime channels, RLS policies, browser UI, or external configuration have passed. Those fields must be completed from the executed test sheet.

> **Correction to an earlier revision of this report.** A previous version stated
> "47 passed and 0 failed (32 booking/refund/atomicity + 15 promo/package)". That
> figure was accurate when written but is now superseded by the six suites in §5.
> Separately, a per-file count of "83 tests" was reported at one point in the
> remediation log; the measured total is 103. Use the numbers in this section,
> which were taken from an actual run.

## 2. Execution Metrics

| Metric | Result |
|---|---:|
| Test cases specified | 57 |
| Test cases executed | To be completed |
| Passed | To be completed |
| Failed | To be completed |
| Blocked | To be completed |
| Not executed | To be completed |
| Defects logged | To be completed |
| Critical defects | To be completed |
| High defects | To be completed |
| Medium defects | To be completed |
| Low defects | To be completed |
| Defects resolved | To be completed |
| Defects retested and closed | To be completed |
| Automated assertions before alpha | 103 passed / 0 failed (see §5) |

**Metric formula:** `Pass rate = Passed / Executed x 100`. Do not count blocked or not-executed cases as passes.

## 3. Severity Breakdown

Complete this table from `03_DEFECT_LOG.csv`. A zero is valid only after the defect log and executed cases have been reviewed.

| Severity | Open | In Progress | Resolved | Retested & Closed | Total |
|---|---:|---:|---:|---:|---:|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 0 | 0 | 0 |
| Low | 0 | 0 | 0 |
| **Total** | **0** | **0** | **0** | **0** | **0** |

### Severity definitions

- **Critical:** system crash, data loss/corruption, unauthorized access, duplicate financial transaction, phantom/orphan booking, or complete blocker of a critical path.
- **High:** booking/auth/payment/refund/role workflow is materially broken with no acceptable workaround.
- **Medium:** important feature or UI behavior is wrong but a reliable workaround exists; includes material responsive distortion.
- **Low:** cosmetic issue, minor copy defect, or low-impact edge case with no integrity or workflow risk.

## 4. Coverage Result

| Area | Cases | Result / evidence |
|---|---|---|
| Environment, migrations, browser | ENV-001 to ENV-002 | ____________________ |
| Authentication and account lifecycle | AUTH-001 to AUTH-009 | ____________________ |
| Customer booking and scheduling | BOOK-001 to BOOK-014 | ____________________ |
| Promo and service pricing | PROMO-001 to PROMO-006 | ____________________ |
| Payments, OCR, QR, ledger, refunds | PAY-001 to PAY-011 | ____________________ |
| Admin/staff operations | OPS-001 to OPS-010 | ____________________ |
| Security and authorization | SEC-001 to SEC-003 | ____________________ |
| Reliability and compatibility | NFR-001 to NFR-002 | ____________________ |

## 5. Automated Evidence

The following was observed before staging execution (`npm test`):

```text
=== 32 passed, 0 failed ===   tests/booking_atomic.test.js
=== 15 passed, 0 failed ===   tests/promo_package_semantics.test.js
=== 12 passed, 0 failed ===   tests/transaction_amounts.test.js
=== 19 passed, 0 failed ===   tests/vat_split.test.js
===  9 passed, 0 failed ===   tests/email_idempotency.test.js
=== 16 passed, 0 failed ===   tests/ocr_ledger_invariants.test.js
Total: 103 passed, 0 failed
```

Additional automated suites. These are run separately because they either need
live credentials or inspect source rather than execute the app:

| Command | What it establishes |
|---|---|
| `npm run test:source` | 28 structural assertions over the email modules (types present, VAT formula, authorization posture) |
| `npm run test:live` | Submits a real booking and asserts it **succeeds** — a functional guard, not a presence check |
| `npm run test:emails` | One email per event, duplicates refused (incl. 3 concurrent), receipt PDF on confirmation only, OCR fields present in the rendered HTML |
| `npm run test:ledger` | The OCR-scanned amount is visible in the booking ledger while unverified, and cannot be counted as recognised revenue |

Attach the full console output or CI run URL here: ____________________

Required staging evidence:

- `npm run preflight` result: ____________________
- `npm run test:live` result: ____________________
- `npm run test:ledger` result: ____________________
- Browser test run / screenshots: ____________________
- Email/link/OTP evidence: ____________________
- OCR/payment fixture evidence: ____________________
- RLS/role evidence: ____________________
- Realtime/chat evidence: ____________________
- Defect log reference: ____________________

## 6. Notable Findings and Residual Risk

Record only findings supported by executed evidence. The following are known design boundaries that must be stated if not separately tested or mitigated:

- **Unverified OCR money is reported, never recognised.** The ledger rule counts
  money as received only when the payment status is `PAID|REFUND_PENDING|REFUNDED`;
  `FOR_VERIFICATION` is excluded by design. A customer's OCR-scanned receipt is
  therefore visible in `booking_financial_ledger()` as
  `pending_verification` / `pending_ocr_detected` with an explicit `ocr_variance`,
  and contributes ₱0 to recognised revenue until an admin verifies it. This is
  intended accounting behaviour, not a defect — but it does mean **no financial
  total should be read as "collected" without checking `pending_verification`.**
- **`booking-lifecycle` is deployed `--no-verify-jwt`** and accepts `bookingId` in
  the request body while using the service role internally. The enforced check is
  a Bearer-credential presence test, which stops anonymous calls but does **not**
  distinguish privileged callers from an ordinary logged-in customer. Per-booking
  authorization is a required follow-up; until it lands, treat this endpoint as an
  open surface for cross-booking information disclosure.
- **Receipt duplicate protection is byte-level SHA-256,** so an exact same-file
  replay is covered but a re-encoded or re-photographed copy is not equivalent
  evidence of detection.
- **External OCR, Resend, Supabase Auth, storage, realtime, and browser behavior
  cannot be proven by the local migration/pricing tests.**
- A passing code-level test does not prove that all migrations are applied
  correctly to the target database; the live preflight and functional booking
  guard are required.
- No production live-money or large-scale load claim should be made from alpha
  results.

## 7. Readiness Decision

### Decision rule

The system is **ready to proceed to Beta / User Acceptance Testing** only when:

1. All Critical and High cases pass.
2. There are zero open Critical or High defects affecting booking, auth, payment, refund, privacy, authorization, or data integrity.
3. All 103 automated assertions pass on the candidate build.
4. Live staging preflight and booking prerequisite checks pass.
5. Any blocked or deferred case has a named owner, reason, mitigation, and target date.
6. Product/business and release owners approve the residual risk.

### Final decision

- [ ] **READY FOR BETA / UAT**
- [ ] **NOT READY: FIXES REQUIRED**
- [ ] **CONDITIONAL: APPROVED WITH DOCUMENTED EXCEPTIONS**

**Decision rationale:**

______________________________________________________________________________

______________________________________________________________________________

## 8. Readiness Sign-Off

| Role | Name | Decision | Signature / date |
|---|---|---|---|
| Developer | ____________________ | ____________________ | ____________________ |
| Alpha tester | ____________________ | ____________________ | ____________________ |
| Product/business owner | ____________________ | ____________________ | ____________________ |
| Release owner | ____________________ | ____________________ | ____________________ |

## 9. Manuscript Statement After Completion

Use this paragraph only after the execution metrics and sign-offs are completed:

> The Speedway AutoxMoto system underwent controlled alpha testing across authentication, customer booking, walk-in registration, scheduling, promo and package pricing, payment verification, refunds, staff operations, notifications, chat, authorization, and responsive browser behavior. A total of ______ test cases were executed: ______ passed, ______ failed, and ______ were blocked. ______ defects were recorded, of which ______ were resolved and ______ were retested and closed. No open Critical or High defects remained at sign-off. Based on the recorded evidence and stakeholder approval, the system was deemed [ready / conditionally ready / not ready] to proceed to Beta User Acceptance Testing.