# Comar Garage — Alpha Tester Onboarding & System Guide

Audience: experienced testers (about 3 years). This guide describes what exists, where it runs, and what to leave alone. It does not tell you what to click; the charters in Document 2 do that.

---

## 1. What the system is

Comar Garage is a web platform for an auto-detailing and car-care shop. It runs the whole booking lifecycle: a customer books services, pays (downpayment, full, or manual amount) with a GCash/bank receipt or cash, the shop verifies the payment, staff perform the work with photo evidence, and the customer gets emails and receipts. Admins run the business: schedule, catalog, payments, refunds, reports, accounts.

### 1.1 Architecture

| Layer | Technology | Where it runs |
|---|---|---|
| Frontend | React 18 + Vite 5 (SPA, lazy-loaded routes). Admin financial reports use Tailwind v4 + shadcn | Vercel — https://comargarage.com |
| Backend API | Node/Express (`backend/server.js`), server-side Tesseract OCR, email dispatch, background jobs | Render (service name `speedway-backend` is an old name and intentionally unchanged), auto-deploys from `main`, health check `GET /api/health` |
| Database | Supabase Postgres: RLS on every table, SECURITY DEFINER RPCs, triggers, views, realtime | Supabase project `nsmytxlaidmndtqxctrw` |
| Edge Functions (Deno) | `booking-lifecycle`, `send-notification-email`, `send-refund-receipt`, `send-status-email` | Supabase, `verify_jwt=false` (they authenticate themselves) |
| Email | Resend | via the edge functions/backend |
| Storage | Buckets `service-proofs` (private), `payment-receipts`, `chat_media`, `receipts` (public) | Supabase Storage |

Notes that matter when testing:
- Shop timezone is **Asia/Manila**. All schedule rules, reminders and no-show timing are evaluated in it, regardless of your device timezone.
- The database is the authority for money and booking acceptance. The UI only previews. If the UI and a database result disagree, that is a defect.
- The backend runs on Render's starter plan, so the first request after idle can be slow. Report slowness only if it persists after warm-up.

### 1.2 Roles

Stored in `profiles.role` (`CUSTOMER`, `STAFF`, `ADMIN`; the enum also has `SUPER_ADMIN`). Each role has its own area and its own terms and conditions text (shown on first open; the checkbox unlocks only after scrolling to the bottom — see Known Issues, this is still being built).

**Customer** (`/customer/*`)
- Dashboard; **Book** (4-step wizard: schedule → services → fleet/vehicles → review & payment); My Bookings; Booking details; Billing; Garage (vehicles and fleets); Notifications; Settings; Profile; Receipt (`/customer/receipt/:id`).
- Floating chat bubble to message the shop.

**Staff** (`/staff/*`)
- My Jobs (`/staff`, `/staff/tasks`); Job details (`/staff/job/:id`); Work History; Duty & Shift; Notifications; Settings; Profile.
- Sees only jobs assigned to them, and only for bookings whose downpayment is verified.

**Admin** (`/admin/*`)
- Dashboard; Bookings; Booking details; Walk-in; Schedule/Calendar; Payments; Refunds; Analytics / Financial Reports (also `/admin/finance`); Business Hub (Business Profile, Schedule Rules, Service Catalog, Promos, Payment Policy); Audit Logs; Accounts; Users; Notifications; Settings; Profile.
- Admin accounts are created by invitation (`/accept-invite`); customers self-register or are invited after a walk-in booking.

Public/auth routes: `/` (landing), `/login`, `/auth/callback`, `/password-confirmation`, `/accept-invite`.

### 1.3 Core domain rules (what the system is supposed to do)

**Booking status** (`booking_status`): `scheduled → confirmed → in_progress → completed`, or `cancelled`. Per-vehicle progress is separate (`QUEUED / IN_PROGRESS / COMPLETED`). A booking can contain several vehicles, each with several services.

**Payment record status** (`payment_status`): `PENDING, FOR_VERIFICATION, PAID, REFUND_PENDING, REFUNDED, REJECTED`. Methods: `CASH, GCASH, BANK_TRANSFER`. Types: `Full, Downpayment, Manual`. Booking-level payment status: `unpaid, pending, partially_paid, paid, refunded`.

**Downpayment policy** (editable in Business Hub → Payment Policy, stored in `business_config`): 30% of the total, with ₱1,000 minimum; 50% when the total exceeds ₱2,000. Cash is not offered to customers at ₱1,000 and above (admins can still record cash).

**Money (single source of truth)**: the database ledger (`booking_ledger_v`, RPC `booking_financial_ledger`) is the only place "paid / balance / credit / refunded" is computed. Only the **net received** amount counts toward settlement; a transfer fee is informational. Every screen, email and receipt must show the same figures.

**Receipts**: one receipt per verified payment (`RCP-<payment id>`), plus a cumulative Statement of Account when the booking is fully settled.

**OCR receipt checking** (server-side Tesseract, `POST /api/ocr/verify-receipt`):
- Customers: strict — amount, reference number and recipient are checked. If the recipient cannot be read, the payment goes to manual admin verification instead of failing.
- Admins: lenient.
- Images only; max 10 MB; click or drag-and-drop upload.
- Scan sessions expire after 20 minutes; the same image hash cannot be reused; a reference number can be used on only one payment (`payments.reference_number` is unique).
- Rate limit: 8 scans per 5 minutes per identity; 4 consecutive failures lock automatic OCR for 5 minutes.

**Schedule rules**: opening hours, closed weekdays, blocked slots/closures, lead time, advance-booking window, bay capacity (bays are per vehicle, and a booking's duration is its longest vehicle plus a buffer). Enforced in the database by `create_booking_atomic_secure` and a schedule-violation trigger.

**Lifecycle jobs (background)**
- No-show sweep: a confirmed booking with no start **1 hour after its scheduled start** is flagged no-show; there is a 24-hour undo window. (The owner believes the grace should be 30 minutes — unresolved. Test against the current 60 minutes and report observations.)
- Unpaid hold sweep: bookings with no payment activity are released.
- Reminder email job runs every 5 minutes. It is skipped when the booking was made less than 1 hour before its start.
- Emails are sent exactly once per event (claim table `booking_email_deliveries`, RPC `claim_booking_email`). A duplicate email is a defect.

**Login protection**: staged lockout ladder per account. Repeated failures escalate through timed locks; the final rung is a 60-minute lock plus a security notice email containing a reset link.

**Contact validation** (same rules in frontend, backend and database): Philippine mobile `09xxxxxxxxx` (11 digits); emails must be well-formed.

**Walk-in flow**: an admin creates a booking for a customer without an account. The customer receives an invitation to register, valid **7 days**; on that registration only the **email is locked**; name and phone are editable and changes propagate to ongoing bookings.

**Drafts and promo codes**: in-progress wizard state is saved as `booking_drafts` (owner-only). Pressing **Cancel** asks for confirmation, then deletes the draft. Promo codes are admin-managed and applied in the last wizard step.

### 1.4 Data model (tables you will see referenced)

`profiles`, `bookings`, `booking_vehicles`, `booking_vehicle_services`, `payments`, `customer_credit_ledger`, `payment_refund_allocations`, `service_photos`, `booking_events`, `booking_messages`, `booking_email_deliveries`, `booking_drafts`, `ocr_scan_sessions`, `services`, `service_pricing`, `service_pricing_matrix`, `service_requirements`, `service_bays`, `resources`, `blocked_slots`, `business_config`, `shop_settings`, `promo_codes`, `promo_services`, `promo_vehicle_types`, `promos`, `fleet_groups`, `fleet_group_vehicles`, `vehicles`, `staff_shifts`, `notifications`, `system_broadcasts`, `audit_logs`, `audit_trails`, `invites`, `guest_registration_invites`, `pending_registrations`, `login_lockout_policy`, `login_security_notices`, `password_confirmation_requests`, `account_recovery_otps`, `qr_change_otp`, `email_sent_statuses`, `test_bookings`.

As a black-box tester you normally see these through the UI. Admin → Audit Logs is the best place to confirm that an action left a trace.

---

## 2. Access and environments

| Item | Detail |
|---|---|
| Live site | https://comargarage.com (the only deployed frontend; there is **no separate staging site**) |
| Backend | Render service behind the live site; health: `<backend-url>/api/health` (ask the QA lead for the URL) |
| Database | One production Supabase project. **Alpha testing writes real rows to it.** |
| Local run (optional, developers) | `frontend`: `npm install && npm run dev`; `backend`: `npm install && npm start`; a local Supabase stack (`supabase start`) can be used for destructive tests |

### 2.1 Test accounts

Production passwords are never stored in the repository. The QA lead provisions these before the alpha window and sends credentials privately:

| Purpose | Role | Notes |
|---|---|---|
| `alpha.admin@…` | ADMIN | Created through the admin invitation flow. Do not use the default/owner admin. |
| `alpha.staff1@…`, `alpha.staff2@…` | STAFF | Two, so you can test assignment and "only my jobs" isolation. |
| `alpha.customer1@…`, `alpha.customer2@…` | CUSTOMER | Two, so you can test data isolation between customers. |
| Fresh mailbox you control | none | For registration, invitation, reminder and recovery emails. |

Use plus-addressing or disposable inboxes you can read. Every email in this system is real (Resend).

### 2.2 Constraints — read before you start

1. **Real money is not involved, but real emails are.** Never use another person's address.
2. **Do not run** `scripts/sql/reset-bookings-clean-slate.sql` or `scripts/sql/clear-reference-numbers.sql` against production. They are owner-run launch gates.
3. Reference numbers are single-use. Use a fresh sample receipt image (or edit the reference) for each successful booking test, otherwise you will hit the duplicate guard (which is itself a valid test).
4. Keep test data identifiable: put `ALPHA-<yourinitials>` in names, vehicle plates and notes.
5. Don't test denial-of-service or load against production. Rate limits exist; probing them with a handful of requests is fine.
6. The admin password-leak protection and OTP expiry are Supabase dashboard settings, not application code — don't file them.
7. No security testing against other people's data. Cross-account access attempts must use your own two test accounts.
8. Record the time (with timezone) of each failing action so logs can be matched.

### 2.3 Devices

Desktop Chrome/Edge/Firefox, mobile Safari/Chrome at about 375 px width. The staff screens are used on phones in the shop; the owner already reports the staff layout is poor on small screens (see below), so mobile staff findings are especially welcome.

---

## 3. Known issues and out-of-scope (do not report as new)

**Not built yet (planned in the master plan)**
- Role-specific terms and conditions with scroll-to-accept, and the admin Terms editor in Business Hub.
- Admin "Chat" inbox page with booking tags; chat bubble roaming within the screen.
- "To be received" amount option for admins (admin-only, no input).
- Customer "Pay remaining balance" modal with OCR; admin top-up cash vs digital selector.
- Promo code administration screen in Business Hub (promo codes are applied by customers if they exist) and real deletion of promos.
- Walk-in form wording ("Cancel booking" → "Cancel") and admin booking-details Cancel button.
- Calendar: sticky header and a timeline bug (a 2 pm slot rendering in the 1 am row).
- Financial report print view prints a blank page; the old analytics view and `/admin/finance/classic` still exist.
- AI analytics assistant (admin).
- Staff screens' responsive layout on phones is acknowledged as poor.
- Server does not yet recompute booking totals from the catalog (client-tampered totals may be accepted).
- Opening-hours rule ignores minutes (e.g. 8:30 opening behaves as 8:00).
- Search boxes in some admin lists reportedly do not match correctly (being fixed; report specifics only if the list is in the charters).

**Environment limits**
- Leaked-password protection and OTP expiry are dashboard-only settings, not enabled by code.
- No-show grace is 1 hour (owner wants to decide whether 30 min).
- First request after idle on Render may take several seconds.

**Out of scope**: third-party behaviour (Supabase, Resend, Vercel, Render outages), payment-provider internals (no real GCash/bank integration exists — receipts are checked by OCR only), accessibility audit to WCAG level (usability observations welcome), localization.

---

## 4. How testing runs

- Sessions are time-boxed (60–90 minutes) against one charter from Document 2. Take notes as you go; the note-taking template is in Document 3.
- File defects as you find them using Document 3. One defect per report.
- When a charter reveals something not covered by it, follow the lead and note it as a "bonus" finding.
- At the end of each session, write three lines: what you covered, what you did not, and what worried you.

## 5. Source documents

`docs/MASTER-PLAN.md` (what is planned and why), `docs/ACCOUNT-TIER-ARCHITECTURE.md` (how data and permissions flow between the three roles), `scripts/verify-*.mjs` (developer guard scripts — useful for understanding intended behaviour).
