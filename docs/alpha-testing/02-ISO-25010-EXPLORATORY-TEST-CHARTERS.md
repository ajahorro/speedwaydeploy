# Comar Garage — ISO/IEC 25010 Exploratory Test Charters

Format of each charter: **Explore** (target) **with** (resources/data) **to discover** (information). Time-box 60–90 minutes. Use two accounts per role where isolation matters. Scenarios are prompts, not scripts — vary them and follow what looks suspicious.

Index
- Part A — Charters by quality characteristic (A1–A8)
- Part B — Charters by module/feature (B1–B16)

Data hygiene: prefix everything with `ALPHA-<initials>`. Each receipt reference number can be used once.

---

## Part A — By ISO/IEC 25010 quality characteristic

### A1. Functional suitability (completeness, correctness, appropriateness)
**C-FS-1 Money agrees everywhere.** *Mission:* Explore one booking taken through downpayment → top-up → settlement with the booking detail pages (customer + admin), Billing, Admin Payments, Refunds, Dashboard, Financial Reports, emails and receipt PDFs, to discover any place where paid / balance / credit / refunded differs.
- Scenarios: transfer fee present (net < declared); two instalments; overpayment (credit); partial refund; cancel after payment; "Manual" amount; cash recorded by admin.
- Edge cases: ₱1,000 / ₱2,000 boundaries of the downpayment rule (₱999.99, ₱1,000, ₱2,000, ₱2,000.01); promo discount that drops the total below a boundary; multi-vehicle totals; add-service after payment.
**C-FS-2 Booking acceptance rules.** *Mission:* Explore the wizard and Walk-in with the Business Hub schedule rules to discover bookings accepted that should be refused (or refused wrongly).
- Closed weekday, blocked slot/closure, before opening / after closing, a service that runs past closing, lead time, advance window, all bays full, two vehicles needing two bays, minutes in opening hours (8:30), midnight / date change in Asia/Manila vs your device timezone.
**C-FS-3 Lifecycle correctness.** *Mission:* Drive bookings through every status transition (scheduled, confirmed, in_progress, completed, cancelled, no-show) as the proper role to discover transitions that are allowed out of order or that leave payment/ledger/email state inconsistent.

### A2. Performance efficiency
**C-PE-1 Perceived speed.** *Mission:* Explore first load and navigation for each role on throttled 4G and a cold backend to discover slow screens, repeated fetches and layout jumps.
- Watch the Network tab: duplicate requests, requests per row (N+1), large images in galleries, realtime reconnect storms after sleep/wake.
**C-PE-2 Volume.** *Mission:* Explore admin Bookings, Payments, Audit Logs, Notifications and customer My Bookings with ≥100 rows to discover unpaginated lists, slow search/filter and memory growth.
**C-PE-3 OCR cost.** *Mission:* Explore the receipt scan with large (9–10 MB), tiny and rotated images to discover timeouts, UI that stays blocked, or the rate limiter (8 scans / 5 min) failing silently.

### A3. Compatibility (co-existence, interoperability)
**C-CO-1 Browsers and devices.** *Mission:* Explore the wizard, Booking details and the staff job screen on Chrome, Edge, Firefox, iOS Safari, Android Chrome at 375 px and 768 px to discover broken layouts, unusable controls (hit areas, sticky bars covering buttons), and light/dark theme contrast failures.
**C-CO-2 Email clients.** *Mission:* Open every lifecycle email in Gmail web/app, Outlook, Apple Mail to discover broken buttons (VIEW BOOKING DETAILS), missing receipt PDFs, dark-mode illegibility.
**C-CO-3 Links across state.** *Mission:* Click email links while logged out, logged in as a different role, and on a phone to discover wrong landing pages or lost `next` targets (login → booking details; registration pre-filled from invitation).

### A4. Usability (appropriateness, learnability, error protection, UI aesthetics, accessibility)
**C-US-1 First-time customer.** *Mission:* Register and book without guidance to discover confusing wording, dead ends and unclear payment instructions.
**C-US-2 Error protection.** *Mission:* Explore destructive and irreversible buttons (cancel booking, delete vehicle/fleet, delete service, refund, reject payment, release bay, upload photos) to discover actions that fire without confirmation, confirmations with wrong wording, and double-submit.
**C-US-3 Staff in the bay.** *Mission:* Explore the staff job flow on a phone, one-handed, to discover the start-service checklist, photo box and finish flow being confusing or unreachable.
**C-US-4 Keyboard and screen reader basics.** Tab order in modals (image preview, receipt popup, confirmation dialogs), focus trap, Esc to close, labels on icon-only buttons.

### A5. Reliability (maturity, availability, fault tolerance, recoverability)
**C-RE-1 Interrupted flows.** *Mission:* Explore the wizard, OCR scan and payment upload with mid-flow network loss, tab close, refresh, back button, token expiry and two tabs to discover lost data, duplicate bookings or stuck "uploading" states. Verify draft restore and that Cancel deletes the draft only after confirmation.
**C-RE-2 Background jobs.** *Mission:* Explore the no-show sweep, 24 h undo, unpaid-hold release and 5-minute reminder job with bookings placed at boundary times (booked 59 vs 61 minutes before start; 59 vs 61 minutes after start) to discover wrong triggers, missed or repeated emails/status changes.
**C-RE-3 Exactly-once.** *Mission:* Re-trigger the same event (re-verify a payment, refresh during verification, double-click confirm, two admins on one payment) to discover duplicate emails, duplicate receipts, duplicate ledger rows or conflicting statuses.

### A6. Security (confidentiality, integrity, non-repudiation, accountability, authenticity)
Use only your own test accounts.
**C-SE-1 Role isolation.** *Mission:* As customer1 try customer2's booking/receipt/billing/chat/photo URLs by ID; as staff try admin routes, other staff's jobs and jobs with unverified downpayment; as customer try `/admin` and `/staff` routes — to discover any data or action not blocked by RLS/route guards.
**C-SE-2 Storage.** *Mission:* Explore service photos (private bucket), payment receipts, chat media with copied URLs while logged out/in as another user to discover exposed files and guessable names.
**C-SE-3 Authentication.** *Mission:* Explore login lockout ladder (stages, 60-minute final lock, security notice email with reset link), password reset, email-change flow, invitation reuse/expiry, and session handling after role change to discover bypasses or lockout of the wrong user.
**C-SE-4 Input trust.** *Mission:* Tamper with request bodies in dev tools (booking totals, `userId`, payment amount, promo discount, status) to discover server-side trust failures. (Known: total re-verification is not yet implemented — record exact behaviour.)
**C-SE-5 Audit trail.** *Mission:* Perform sensitive admin actions (verify/reject payment, refund, cancel, role change, catalog edit) and confirm each leaves a correct Audit Log entry with actor, before/after and time.
**C-SE-6 Injection and content.** Names, notes, chat messages, promo codes with HTML/script/emoji/very long strings — look for stored XSS in admin views, emails and PDFs.

### A7. Maintainability (modularity, reusability, analysability, modifiability, testability)
Black-box angle:
**C-MA-1 Configuration propagation.** *Mission:* Change Business Hub values (hours, closed weekday, closure, bay count, service price, promo, downpayment rate, vehicle types) while another browser has the wizard open to discover values that need a reload, are cached in localStorage, or never propagate.
**C-MA-2 Diagnosability.** *Mission:* Provoke failures (reuse a reference number, offline upload, expired scan session) and judge whether error messages and the console/log give enough to locate the cause.

### A8. Portability (adaptability, installability, replaceability)
**C-PO-1 Environments.** *Mission:* Explore behaviour under different device timezones, locales (date/currency formatting), screen zoom 200%, and PWA/"add to home screen" to discover Manila-time dependencies leaking into local time.

---

## Part B — By module / feature

### B1. Registration, login, invitation, recovery
**Explore** auth screens **with** fresh mailboxes, invited walk-in customers and expired links **to discover** account-state bugs.
- Self-register (PH mobile `09xxxxxxxxx`: 10 or 12 digits, letters, +63 prefix; email without `@`, with spaces, upper-case); duplicate email.
- Walk-in invitation: only email locked, name/phone editable, edits flow into the pending walk-in booking; expired (>7 days) and reused invites.
- Admin invitation `/accept-invite`; recovery OTP; `password-confirmation` for sensitive actions; email change request/confirm.
- Lockout ladder: wrong password repeatedly, then correct one during lock; does the real owner receive the notice email?

### B2. Customer booking wizard (4 steps)
**Explore** `/customer/book` **with** single/multi-vehicle, fleets, promo codes **to discover** pricing, scheduling and state bugs.
- Step 1 schedule (calendar, time picker, closures); Step 2 services (per vehicle type pricing, requirements, archived/deleted services); Step 3 fleet (add vehicle button under the first vehicle, success popup, Create Fleet disabled until a vehicle exists); Step 4 review & payment.
- Navigation back/forth keeps selections; draft restored after refresh; Cancel → confirm → draft deleted.
- Redundant customer-details block under "select schedule" (should not exist).
- Promo: expired, wrong vehicle type/service, stacked, case-insensitive, discount crossing the downpayment threshold.
- Payment: method GCash/bank vs cash (hidden at ≥ ₱1,000), Downpayment/Full/Manual amount (manual below required downpayment).

### B3. Receipt upload and OCR
**Explore** payment upload **with** real-looking GCash/bank screenshots, wrong amounts, wrong recipient, edited images, phone-photos-of-screens, PDFs **to discover** wrong accept/reject decisions.
- Customer strict vs admin lenient; recipient unreadable → manual review path; amount mismatch; duplicate reference (even across customers); same image re-uploaded; scan session expiry after 20 minutes; rate limit; click vs drag-and-drop; non-image file; >10 MB.
- UI should block other clicks while scanning; cancel/close mid-scan.
- References are saved only for successful bookings (a failed or abandoned attempt must not burn a reference).

### B4. Customer booking management (My Bookings, Details, Billing, Receipt, Garage)
**Explore** post-booking screens **with** bookings in every status **to discover** inconsistent labels/amounts and missing actions.
- Cancel (fee/refund text vs actual), reschedule rules, add-service (previous 500 error with `payment_type` — verify fixed), top-up/pay remaining balance, receipts per payment, Statement of Account on settlement, credit visibility.
- Garage: add/edit/delete vehicle with active bookings; fleet membership; plate duplicates.
- Search/filter boxes actually filter.

### B5. Admin bookings and booking details
**Explore** `/admin/bookings` and details **with** bookings in all states **to discover** wrong controls, duplicated panels, status/ledger drift.
- Single "Payment Verification" container (audit + receipts together); verify / reject / force-confirm calling the same logic as Admin Payments; assign staff; release bay (button styling); top-up (cash vs digital not yet distinguished — record); cancel with and without payment; edit booking; internal vs customer chat.
- Empty/irrelevant actions should be greyed out, not clickable.

### B6. Walk-in
**Explore** `/admin/walk-in` **with** new and existing customers **to discover** guest-customer handling errors.
- Cash vs digital, downpayment/full/manual, OCR lenient, missing phone/email, invite email sent, booking visible to the customer after registering, name/phone edits propagating to ongoing bookings.

### B7. Admin Payments and Refunds
**Explore** `/admin/payments`, `/admin/refunds` **with** pending, flagged, rejected and overpaid cases **to discover** wrong amounts, repeatable actions and missing emails.
- Verify partial amounts; reject with reason; flagged-for-review path; refund full/partial/excess; excess-payment refunds should not show a deduction fee; refund allocation across payments; credit ledger; refund receipt email; refund exceeding paid.

### B8. Schedule / Calendar
**Explore** `/admin/schedule` **with** bookings across bays and days **to discover** display and capacity errors.
- Header sticky while scrolling; timeline slot rows match real times (2 pm must not appear at 1 am); multi-hour bookings across rows; closures/blocked slots; drag/resize if available; Manila-time vs device-time; mobile layout.

### B9. Business Hub
**Explore** each tab **with** a second browser open as a customer **to discover** values not propagating or not enforced.
- Business Profile; Schedule Rules (hours, closed days, closures, lead/advance, bays/capacity); Service Catalog (add/edit/archive/delete, built-in services must stay deleted, per-vehicle-type prices, mobile button layout, master-edit placement); Promos (create, edit, truly delete — deleted promo must stop working immediately); Payment Policy (downpayment rate/min/threshold; wizard preview updates).
- Concurrent edits by two admins.

### B10. Analytics / Financial Reports / Dashboard
**Explore** reports **with** known seeded bookings **to discover** numbers that don't reconcile.
- KPIs vs sum of booking ledgers; date-range presets/custom; method and status filters; chart vs table totals; CSV export totals; outstanding and pending-verification; print (blank page — known) ; old analytics view still reachable at `/admin/finance/classic`; dashboard revenue vs reports.

### B11. Accounts and Users
**Explore** `/admin/accounts`, `/admin/users` **with** admin/staff/customer rows **to discover** privilege or lifecycle mistakes.
- Invite admin/staff; revoke access; demote last admin (must be refused); deactivate staff with active services; edit staff details; search; role change effect on live sessions.

### B12. Staff job flow
**Explore** `/staff`, `/staff/job/:id` **with** two staff and several assigned vehicles **to discover** start/finish gating bugs.
- Only assigned jobs; only after downpayment verified; customer name/contact shown; start checklist, "Add before photo" then Start; completion-photo box appears only after the service started; photo upload confirmation ("locked once submitted"); finish requires ≥1 after photo; multi-vehicle booking progress; paused status; image viewer.
- Past scheduled start but before no-show grace: can staff still start? After no-show flag?
- Work History totals; Duty & Shift toggle (also tries with another user's id); preferences; page crash resilience on bad data.
- Phone layout overall (known weak area).

### B13. Chat
**Explore** the floating chat and booking chat between customer1, customer2, staff and admin **to discover** leakage and delivery problems.
- Thread isolation; unread badges; realtime delivery and reconnect; images (`chat_media`); long messages; floating bubble stays inside viewport when dragged; admin has no inbox page yet.

### B14. Notifications and email
**Explore** in-app notifications and every lifecycle email **to discover** wrong content, wrong recipients, duplicates or missing sends.
- Events: booking created, payment pending/verified/rejected, confirmed, reminder (not when booked < 1 h before), started, completed, cancelled, no-show, refund, add-service receipt, settlement statement, security notice, invitations.
- Links: VIEW BOOKING DETAILS → login with `next` → correct page; amounts in the email equal the app; receipt PDF numbers; broadcasts (`system_broadcasts`) read-state per user.

### B15. Settings, Profile, Terms
**Explore** each role's Settings/Profile **to discover** validation and persistence gaps.
- Name/phone/email-change validation; theme (light/dark) persistence and contrast on every page; profile changes reflected in open bookings; terms: first-open acceptance per role (when built), versioned re-acceptance.

### B16. Audit logs and data integrity
**Explore** `/admin/audit-logs` after running other charters **to discover** missing/incorrect entries, unreadable diffs, and performance issues.
- Check the actor, target, before/after for each sensitive action; filter/search; entries for failed attempts.

---

## Session notes (copy per session)
```
Charter ID:           Tester:            Date/Time (Manila):
Build/commit seen (footer/network):      Browser/device:
Accounts used:        Duration:
Covered:              Not covered:        Worries:
Defect IDs filed:
```
