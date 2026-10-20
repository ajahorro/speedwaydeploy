# Comar Garage — Bug Reporting Protocol & Defect Template

## 1. Principles
1. One defect per report. If two things look related, file two and cross-link.
2. Reproduce at least twice before filing; if you can't, file as "Intermittent" with frequency (e.g. 2/5).
3. Never put real passwords, tokens, or other people's personal data in a report. Redact the Authorization header and cookies from HAR files.
4. Report what you observed, then what you expected, then (optionally) your theory.
5. Money, privacy and data-loss findings are reported to the QA lead immediately in addition to filing.

## 2. Severity

| Severity | Definition | Comar Garage examples | Primary ISO/IEC 25010 areas |
|---|---|---|---|
| **Critical** | Data loss/corruption, money shown or stored wrongly, security/privacy breach, system or core flow unusable for a role, no workaround | Customer can read another customer's booking/photos; paid/balance differs between screens or from the ledger; payment verified twice produces two receipts; booking accepted on a closed day; staff can access admin routes; total tampered in request is accepted; app crashes on login for a role | Security, Functional correctness, Reliability |
| **Major** | Important function fails or gives wrong result, workaround exists, or a visible flow breaks for many users | OCR wrongly rejects a valid receipt; reminder sent for last-minute booking; wrong email link target; refund shows deduction fee on excess payment; calendar slot in wrong row; promo deleted still applies; page unusable on phone for staff | Functional suitability, Reliability, Compatibility, Performance |
| **Minor** | Limited impact, easy workaround, or wrong wording/state that doesn't affect data | Missing confirmation on a low-risk action; button not greyed when irrelevant; search ignores case; slow (3–5 s) non-critical list | Usability, Performance, Maintainability |
| **Cosmetic** | Appearance only | Misaligned icons, light-mode contrast, typos, "speedway" text left from the old client name | Usability (UI aesthetics) |

Priority (set by the QA lead, not the tester): P0 fix now, P1 before release, P2 next cycle, P3 backlog. Testers may add a "Suggested priority" comment.

Tagging rule: choose **one primary** ISO/IEC 25010 characteristic (Functional suitability, Performance efficiency, Compatibility, Usability, Reliability, Security, Maintainability, Portability) and optionally a sub-characteristic.

Known-issue check: search Document 1 §3 before filing. If it's listed, don't file; add a comment only if you found a new symptom.

## 3. Attachments to collect
- Screenshot or screen recording (include the browser address bar and the time if possible).
- Browser console errors (copy text, not screenshot).
- Failing network request: URL, method, status, response body (redact secrets).
- IDs: booking ID/number, payment ID or `RCP-<id>`, user email of the test account, vehicle plate.
- Time of failure **with timezone** (Asia/Manila), so backend/edge-function logs can be matched.
- For emails: the original message source (headers) or a forward to the QA mailbox.
- For OCR: the receipt image used (test image only) and the result shown.

## 4. Template (copy into a new file `docs/alpha-testing/defects/ALPHA-NNN.md`, or paste into the tracker)

```markdown
# ALPHA-NNN — [Module] Short, specific title

| Field | Value |
|---|---|
| Reported by / date (Manila time) |  |
| Module | e.g. Customer Wizard / Admin Payments / Staff Job / Edge: booking-lifecycle |
| Role & account | CUSTOMER alpha.customer1 / STAFF / ADMIN |
| Charter | e.g. C-FS-1 or B7 |
| ISO/IEC 25010 area | Primary: ______  Sub: ______ |
| Severity | Critical / Major / Minor / Cosmetic |
| Frequency | Always / Intermittent (x of y) / Once |
| Regression? | New / Worked before (when) / Unknown |
| Build | Visible commit/date, deploy time of the site, backend /api/health version |

## Environment
- URL: https://comargarage.com/…
- Browser + version / OS / device, viewport width, light or dark theme
- Device timezone vs Manila
- Network: normal / throttled / offline during step ___

## Preconditions / test data
(Booking IDs, vehicle types, services, promo, payment type, state before you started)

## Steps to reproduce
1.
2.
3.

## Expected result
(What should happen, citing the rule: e.g. "Downpayment = 30% (₱1,000 minimum)", "Reminder not sent when booked < 1 h before start")

## Actual result
(Exact message text, numbers shown, what else changed)

## Impact
(Who is affected, money/data/security involved, workaround)

## Evidence
- Screenshot / recording:
- Console:
- Network request(s):
- Email source / PDF:
- Audit Log entry (if any):

## Notes / suspected cause (optional)
```

## 5. Example (filled in)

```markdown
# ALPHA-014 — [Admin Booking Details] Excess-payment refund still shows a deduction fee

| Field | Value |
|---|---|
| Reported by / date | AB, 2026-10-12 14:05 Manila |
| Module | Admin Refunds |
| Role & account | ADMIN alpha.admin |
| Charter | B7 |
| ISO/IEC 25010 area | Primary: Functional suitability (correctness) |
| Severity | Major |
| Frequency | Always |
| Regression? | Unknown |

## Preconditions
Booking ALPHA-AB-003, total ₱1,200, customer paid ₱1,500 (₱300 excess credit).

## Steps
1. Admin → Refunds → open ALPHA-AB-003.
2. Choose "Excess payment".
## Expected
No cancellation deduction is applied to an excess-payment refund; refund = ₱300.
## Actual
Deduction fee row displayed; refund shows ₱270.
## Impact
Customer under-refunded. No workaround except editing the amount manually.
```

## 6. Triage flow
1. Tester files → QA lead checks for duplicates and known issues within one working day.
2. Lead confirms severity/priority and reproduces Critical and Major items.
3. Developer fixes on `main`; fixed items are marked "Ready to retest" with the commit.
4. The original reporter re-tests and closes, or reopens with new evidence.
5. Weekly summary: counts by severity and ISO/IEC 25010 area, charters covered vs planned.

## 7. Session debrief checklist
- [ ] Every finding filed (or consciously dropped)
- [ ] Time of failures recorded with timezone
- [ ] Test data cleaned or labelled `ALPHA-<initials>`
- [ ] Credentials/secrets not present in any attachment
- [ ] Uncovered areas and worries written in the session notes
