# Master Plan, organized by account type

Status legend: ✅ done and on `main` · ⏳ waiting on the user · 🔲 not started

The plan is ordered so that each account type is opened **once**. Anything that several accounts share
(components, the booking wizard, the email system) is built in Part 1 or Part 2 and then reused, so we
never return to an account to redo something we could have done in the same pass.

---

## Part 0. Gates (nothing below starts until these are settled)

| # | Item | Owner | Status |
|---|---|---|---|
| 0.1 | Confirm the live site (Vercel and Render, built from `main`) shows the Phase 0–3 changes | user | ⏳ |
| 0.2 | Run `scripts/sql/reset-bookings-clean-slate.sql` in the SQL Editor (back up first). Empty the `service-proofs`, `payment-receipts` and `chat_media` buckets if wanted. I then verify read-only. | user | ⏳ |
| 0.3 | Supabase Security Advisor batch 2: initplan wrapping, duplicate indexes, duplicate permissive policies, bucket listing, EXECUTE revokes on SECURITY DEFINER functions, "policy always true" review. Leaked-password protection is a Dashboard toggle (Authentication → Password security). Test on scratch, then ask before applying to production. | me | 🔲 (investigation done) |
| 0.4 | **Hotfix: admin "add service" returns 500** (`column "payment_type" is of type payment_type_enum but expression is of type text`). Cause: `backend/server.js:1079` lowercases the type (`'downpayment'`, `'full'`) but the enum is `('Full','Downpayment','Manual')`. Fix: normalize to the enum casing in the route and make `mutate_booking_locked` cast defensively. Add a regression test. | me | 🔲 do first |

Already complete: Phases 0–3 (safety, canonical ledger, receipts/emails, Business Hub config as one reader),
booking-linked record cascade, security advisor batch 1, shadcn foundation and Financial Reports rebuild.

---

## Part 1. Shared foundations (affect every account type, so they go first)

### 1.1 Speed, without losing live updates
The whole site is slow. Measure before changing anything.
- Measure: bundle analysis, network waterfall on the customer and admin home pages, count of open realtime channels per tab, Render cold-start time.
- Replace per-component realtime channels with **one realtime hub per session** that subscribes per table and fans out to listeners, with debounced refetch (keeps the "no reload needed" feature for every role).
- Bulk fetches instead of N+1 (the ledger is already bulk; apply the same to chat threads, bookings lists, staff tasks).
- Route-level code splitting for admin-only and heavy pages (charts, PDF, OCR).
- Cache static config in memory for the session (ConfigContext already refetches on realtime).
- Render free-tier cold starts: keep-alive ping or move the hot endpoints to Edge Functions or RPC.
- Acceptance: measured time-to-interactive before and after; a change made in one account appears in another within ~2 s with no reload.

### 1.2 Confirmation on every state-changing action
- One reusable `useConfirmAction` hook and `ConfirmDialog` (shadcn `AlertDialog`) with a pending/disabled state against double-submit.
- Inventory every handler that changes bookings, payments, refunds, config, accounts or chat, for all roles, and wrap each one. The inventory is a checklist in the PR.
- Extend `scripts/verify-single-source.mjs` to flag a direct mutation call that is not routed through the hook.

### 1.3 One image preview dialog
- Global `ImagePreviewDialog` (the receipt pop-up pattern) used by receipts, payment proofs, service photos, chat attachments and OCR images. No `window.open` or `target="_blank"` for images anywhere.

### 1.4 Input validation (shared `PhoneInput`, `EmailInput`)
- Phone: digits only, fixed length and prefix rule for PH numbers, max length enforced.
- Email: must contain `@` and a valid domain; trimmed and lower-cased.
- Applied in registration, booking wizard (customer and walk-in), profile editing, admin staff editing and chat contact forms. Mirror the rules in the backend and as DB check constraints.

### 1.5 Search bars work everywhere
- Find why search is dead (likely controlled input not wired to the list filter) and fix it once in a shared `useSearchFilter`. Verify on every page that has a search box, for admin, staff and customer.

### 1.6 Theme, device and icon polish
- Audit every page at 375, 768 and 1280 px and in light and dark. Fix remaining non-responsive spots and any page that ignores the user's theme preference.
- Icon placement: icons that sit at the left edge instead of centered above their text. Fix via shared icon-above-label component classes, then sweep.
- Add a Playwright-style screenshot check of the main pages at three widths.

### 1.7 Floating chat container
- The bubble is dragged inside an invisible bounds container sized to the viewport, so it can roam the whole screen but never fully leave it (a visible edge margin is always kept). Persist position per user and re-clamp on resize.

### 1.8 Chat data layer (single set of chats)
- Floating chat and the admin Chat page both read the **same** thread source (`admin_chat_threads()` RPC and `booking_messages`). The bubble is only a shortcut that opens the same thread. Fixes the `Chat connection temporarily offline` warning: reconnect cleanly after back-forward-cache restore (`pageshow` handler) and avoid duplicate channel names.
- Booking tags on every thread (ticket-style), in the bubble and the page alike.

### 1.9 Booking wizard (built once, used by customer and admin walk-in)
- Draft persistence: every input is saved to a draft (server-side `booking_drafts`, with localStorage as a fast cache) and restored after reload. **Cancel** deletes the draft entirely after a confirmation.
- "Add vehicle" button sits directly under the first vehicle's details, and a small toast says "Vehicle added successfully".
- Step "Select schedule" no longer repeats customer details (they are read-only at that step).
- The cancel button in booking creation reads **Cancel** for **both customer and admin** (no booking exists yet). It asks for confirmation, then deletes the draft.
- The **last page differs by role**. Customer: summary, optional promo code, terms and conditions, payment instructions and receipt upload. Admin: summary, the walk-in payment step (see 1.10 and 4.2), and no customer-facing terms checkbox.

### 1.10 OCR, reference numbers and the payment step (customer strict, admin lenient)

**Reference numbers: clean slate, then store only on success**
- One-off cleanup (production, after your go): delete **every** stored reference number, wherever it exists: `payments.reference_number`, `ocr_scan_sessions`, and any other column or table holding one, including those attached to past or ongoing bookings. Audit logs, accounts and services stay. Because receipts of past payments lose their reference, this is run after a preview of exactly which columns and row counts it will touch.
- Going forward, a reference number is saved **only when a booking is successfully created with it**. Failed, abandoned or rejected scans store nothing. A unique index on the booked payment's reference prevents reuse.

**Customer OCR (strict)**
- Must read the receipt, and the amount, reference number and date/time must match. The recipient ("to") is an optional signal: if the receipt has none, the payment goes to **admin verification** instead of being rejected.
- Controls are disabled while OCR runs.
- The QR/receipt upload zone accepts **both** click-to-browse and drag-and-drop, **images only**. On mobile it opens the camera or gallery.

**Admin walk-in payment (simple, guided)**
Admin does not need a strict scan. The flow is one screen, top to bottom:
1. **How was it paid?** Cash or Digital, plus **Receive later** (admin only, see 4.2).
2. **Cash:** pick Downpayment, Full or Manual. Downpayment is calculated and locked, Full is the service total and locked, Manual is typed and must be between the required downpayment and the total. A live line shows "Customer still owes ₱X".
3. **Digital:** pick Downpayment, Full or Manual (same amounts as above), then provide the reference in **one** of two ways:
   - type the reference number, or
   - **Scan receipt**: upload, or on mobile take a photo of the phone. The scan fills in the reference number and the sender ("from") details. If a scan is used, its amount must match the amount chosen, otherwise the admin sees both numbers and one-tap options to fix either.
4. A single **Confirm payment** button with a summary line and the confirmation dialog from 1.2.

My simplifications on top of what you described:
- Defaults to **Cash + Downpayment** (the most common walk-in), so most walk-ins are two taps.
- The amount is never typed unless **Manual** is picked, so there is almost nothing to get wrong.
- Reference number is mandatory for every Digital payment, but either typed or scanned, never both required.
- The last-used method is remembered for the shift.
- The same component powers the "add service" pop-up, so there is one payment step to maintain.

### 1.11 Role-specific terms and conditions on first open (added by the owner, to be built)
Every account type has different responsibilities, so each has its **own** terms and conditions text:

| Text | Who must accept it | Where it is edited |
|---|---|---|
| Customer terms | customers (also the text shown on the last page of booking creation, 3.5) | Business Hub, Terms tab (4.5) |
| Staff terms | technicians | Business Hub, Terms tab (4.5) |
| Admin terms | administrators | Business Hub, Terms tab (4.5) |

- **When it appears:** as soon as a newly created account opens its account for the first time (right after sign-in, before anything else, over the dashboard), a pop-up shows that role's terms. It also reappears for existing accounts when an admin publishes a new version of that role's text (each text has a version number; acceptance is stored per account and per version).
- **Scroll to accept.** The "I have read the terms and conditions" checkbox and the Accept button are **not shown until the person has scrolled to the very bottom** of the text. Until then a short hint says "Scroll to the end to continue". Short texts that fit without scrolling enable it immediately. The pop-up cannot be dismissed without accepting (the only other action is signing out).
- **Data:** `business_config` keeps one text and version per role (`terms_customer`, `terms_staff`, `terms_admin` plus versions; the current single `terms_and_conditions` becomes the customer text), and `profiles` records `accepted_terms_version` and `accepted_terms_at` (acceptance is also written to the audit log). Row-level security lets people read the text for their own role and record their own acceptance only.
- **Interplay:** the customer's booking wizard checkbox (last page) and the balance-payment modal (3.10) do not ask again for a version the customer has already accepted.
- **Verification:** new customer, staff and admin accounts each see their own text first; the checkbox is hidden until the bottom is reached; accepting once means it does not return until a new version is published.

---

## Part 2. Email, notifications and account-data propagation (system level, between account passes)

| # | Item |
|---|---|
| 2.1 | **Reminder timing.** The reminder currently goes out together with the confirmation. Send it at least 1 hour before `start_datetime` via a scheduled job (`pg_cron` calling the edge function), idempotent through the existing claim key. **If the booking is created less than 1 hour before the start, no reminder is sent (confirmed).** |
| 2.2 | **Receipt on every verified payment, including a downpayment.** The transaction receipt (`RCP-<payment id>`) goes out on each `payment_verified` event; the cumulative Statement of Account still goes on full settlement. Add a test for the downpayment-only case. |
| 2.3 | **One link, one label.** Every email's button reads **View booking details**. It points to the login page with a return path to the booking if the recipient has an account. If not, it points to registration. Fix the broken URL (the site base URL is read from one config value, with a build check). |
| 2.4 | **Walk-in registration.** The register page opened from the email is pre-filled from a signed invite token that **expires after 7 days**: first name, last name, phone and email. The email is locked. Name and phone can be edited. Password is typed by the customer. |
| 2.5 | **Profile edits propagate.** Changing name, last name or phone updates every ongoing booking and anything role-visible (admin, staff, customer). Finished bookings keep a frozen snapshot, written when a booking reaches a terminal status. Implemented as one trigger on `profiles` plus a snapshot column, so there is no per-screen copying. |
| 2.6 | Every change from 2.x writes to the audit log. |

---

## Part 3. Customer account

| # | Item |
|---|---|
| 3.1 | Booking wizard items from 1.9, 1.10 (drafts, add-vehicle placement and toast, redundant details removed, OCR lock, click-and-drag image-only upload zone, strict customer OCR). |
| 3.2 | **Create fleet** button is disabled until the customer has at least one vehicle (with a hint explaining why). |
| 3.3 | Payment pop-up and receipt images use the global preview dialog (1.3). |
| 3.4 | **Promo code** input on the last booking page, optional. Validated server-side by a `validate_promo_code` RPC (active, within dates, applicable services and vehicle types), applied in the total and re-checked inside `create_booking_atomic_secure`. |
| 3.5 | Terms and conditions text shown on the last page comes from the same source the admin edits (4.5): the **customer** terms (see 1.11 for the per-role texts). Seeded from the current wording (done). |
| 3.6 | Confirmation dialogs on every customer action (cancel booking, reschedule, delete vehicle, and so on) via 1.2. |
| 3.7 | Phone and email validation on the profile and the wizard (1.4). Search bar works (1.5). Responsive and theme pass (1.6). |
| 3.8 | Customer chat uses the shared thread source and the floating bubble (1.7, 1.8). |
| 3.9 | Balance shows admin-authorized "to be received" amounts as part of what is owed (see 4.2). |
| 3.10 | **Pay remaining balance (customer booking details).** See the full spec below the table. |
| 3.11 | **Customer terms and conditions on first open** (role-specific text, scroll-to-accept). Built once in 1.11; the customer text is edited in the Business Hub (4.5). |

### 3.10 Pay remaining balance: spec (added by the owner, to be built)
Problem: a customer whose booking has only a downpayment sees the payment QR in their booking details but has nowhere to send proof of the second payment.

- **Entry point.** The booking details page shows a clear **Pay remaining balance (₱X)** button wherever the balance is shown (the balance summary card, and a compact version in the booking header on mobile). It is visible only while the booking has an outstanding balance and is not cancelled or finished. Nothing else about payment (QR, upload, OCR output, tips, terms) is on the page itself.
- **One pop-up container.** Clicking the button opens one modal that holds everything related to the payment, so it takes no room on the page: the shop QR (enlargeable), the exact amount due, the receipt upload zone (click or drag, images only, one scan at a time), the OCR result, the OCR tips, and the terms and conditions checkbox. Closing the modal discards an unsent upload; it can be reopened.
- **The amount is the point.** OCR reads the amount (the transfer fee included, as printed), but only the net amount received counts toward the booking; the fee is never added to revenue (same rule as the ledger today: fee excluded). The modal shows "Receipt shows ₱X, ₱Y after fees counts toward your balance".
- **Rules for the amount, against the balance due:**
  - **Less than the balance:** blocked. The Submit button stays disabled with a plain message ("The receipt shows ₱X; the balance is ₱Y"). Nothing is stored.
  - **Exactly the balance:** accepted.
  - **More than the balance:** accepted, and the excess follows the existing overpayment logic (banked as customer credit / refund routing), exactly like the booking wizard.
- **Other checks** are the customer rules from 1.10 (recipient optional and sent to admin verification when unreadable, duplicate photo or reference rejected, reference stored only if the payment is accepted).
- **Result.** The accepted payment is created as FOR_VERIFICATION (type "Balance"), appears in the admin Payments queue and the booking's Payment Verification container, and on verification the customer gets the transaction receipt and, when fully settled, the Statement of Account (existing emails). The audit log records submission and verification.
- **Terms checkbox** inside the modal only if the customer has not already accepted the current customer terms (see 1.11); otherwise the modal does not repeat it.
- **Build notes:** reuse the backend OCR endpoint with a "balance" mode (required amount = outstanding balance, minimum enforced), a new `submit_balance_payment` database function (creates the payment against an existing booking with the same duplicate protections as booking creation), and a shared `PaymentProofModal` component that the admin top-up (4.3) can reuse for its digital path.

---

## Part 4. Admin account (largest pass, grouped by screen)

### 4.1 Walk-in booking creation
- Uses the shared wizard (1.9) and the guided payment step (1.10). Button reads **Cancel**.
- The add-service pop-up (screenshot) reuses the same payment step: Cash or Digital, then Downpayment, Full or Manual, plus **To be received** (4.2). Digital needs a reference number, typed or scanned.
- Add-service 500 fixed in 0.4.

### 4.2 "To be received" (admin only)
Confirmed behaviour: **no input at all.** The admin presses **To be received** (the same "Receive later" option in the payment step, and in the add-service pop-up).
- The amount is derived from the service total (for example ₱500 or ₱3,500), minus anything already collected in the same step. It is shown as a fixed amount, never typed.
- It is recorded as one ledger row of a new kind, `RECEIVABLE`. It does **not** count as money received. It **does** count as an unpaid balance, so the customer sees it as a balance they owe and the admin sees it as outstanding for that customer.
- It satisfies the downpayment requirement (the admin deliberately allowed it), so staff can start work.
- Only admins can create it (RLS and RPC check). It is not editable afterwards: to change it the admin cancels it (confirmation) and creates the correct one, so there is never a "re-add payments" calculation.
- When the customer later pays, that payment settles the balance through the normal ledger, and the `RECEIVABLE` row shows "settled by payment X".
- Logged everywhere: audit log, `booking_ledger_v.deferred_amount`, a "Deferred receivables" KPI in Financial Reports, the sales report, the Statement of Account ("Balance to be received") and customer billing.

### 4.3 Booking details
- A **Cancel booking** button here too (not only in Booking Management), behind the confirmation dialog (1.2).
- Any action button with no input yet is **disabled and grayed**, with a tooltip naming what is missing.
- Release bay button restyled so it looks like a button.
- Image previews use the global dialog (1.3).
- *Done:* the Payment Verification Audit and Payment Evidence cards are one "Payment Verification" container.

#### 4.3a Top-up payment must say whether it is cash or digital (added by the owner, to be built)
Problem: the admin "top up payment" action on a booking with a balance does not record how the customer paid. It is currently always saved as a cash/manual entry.

Proposed logic, built on the same guided payment step as the walk-in wizard (1.10 / 4.1) so there is one payment flow to maintain:
1. **Top up** opens one modal (the shared payment component) showing the balance due.
2. **How was it paid?** **Cash** or **Digital** (same two choices as the wizard).
3. **Amount:** "Pay full balance (₱X)" is the default; **Manual** allows a smaller amount (between ₱1 and the balance). No amount above the balance (excess is handled only through the refund/credit flow).
4. **Cash:** recorded as PAID immediately, method Cash, type "Balance" (or "Manual" for a part payment), verified by the admin who recorded it.
5. **Digital:** a reference number is required, typed or scanned (admin OCR stays lenient: it reads and stores the reference and the sender, and warns if the scanned amount differs from the amount chosen). Recorded with method Digital. Admin entry counts as verified (the admin is the verifier) and is stored with the reference; the reference is kept only because the payment is accepted (1.10).
6. **Everywhere it must flow the same way:** the payments table gets the real method, so the ledger, the Payment Verification container, the Financial Reports method breakdown (cash vs digital), the customer receipt and Statement of Account, the audit log ("Top-up recorded: ₱X, Cash/Digital, reference …"), and the settlement email all say the right thing. The confirmation dialog (1.2) summarises method and amount before saving.
7. **Interaction with other flows:** a top-up settles any open "to be received" amount first (4.2, shown as "settled by payment X"); a customer-submitted balance payment (3.10) arrives as FOR_VERIFICATION and uses the same verification actions; the admin top-up never double counts with it (the modal warns when the booking already has a pending customer payment for the balance, and offers to verify that instead).
- Verification: top-up with Cash and with Digital on a booking that has a downpayment; method and reference appear in the booking, payments queue, reports, receipt and audit log; a partial top-up leaves the right balance; an over-balance amount is refused.

### 4.4 Calendar (desktop)
- On scroll, everything on the page stays sticky **except** the full-day timeline (right column), which is the only scrolling region.
- **Time-slot bug:** a 2 PM booking appears in the 1 AM row. Likely a timezone problem: the UI mixes UTC and local when placing bookings. Place bookings using `shop_timezone()` (Asia/Manila) everywhere, with one `toShopTime()` helper and a regression test (booking at 14:00 shows in the 2 PM row, plus a day-boundary case).

### 4.5 Business Hub
- **Terms and conditions editor (Business Hub, "Terms" tab):** three separately editable, versioned texts (customer, staff, admin; see 1.11). Saving a changed text publishes a new version, which asks every account of that role to read and accept it again the next time they open their account. The customer text is the one shown on the last booking page (3.5). Edit actions go through the confirmation dialog and are written to the audit log.
- **Service Catalog:** fix the mobile button layout, and re-lay-out the buttons shown after "Master edit" (desktop and mobile).
- **Promo sub-page:** add **promo codes** (code, scope, dates, usage limit, optional). **Delete is a real delete**, after confirmation: row and join rows removed, not just labeled expired. Expired promos are only hidden by date, never by a delete substitute.
- **Refund hub:** add an **Excess payment** option that hides the cancellation/deduction fee input.
- **Full propagation audit:** for every Business Hub field (hours, bays, closures, catalog, vehicle types, promos, downpayment, terms) a test that changes, adds and deletes it and asserts the change in the customer wizard, admin walk-in, calendar and emails. This extends `verify-single-source.mjs` and the scratch DB suite.

### 4.6 Analytics and financial reports
- **Print report shows a blank page.** Diagnose the print stylesheet (the report is mounted inside a `ui-root` layer, so print rules and hidden containers are likely suppressing content). Fix, and add a print preview check.
- **Remove the old analytics view completely**, along with its toggle and dead code. Keep the current shadcn page only.
- **AI assistant** for admins on the analytics page: quick questions and report creation.
  - **Provider (my recommendation, fits "fast, light, easy to load"):** Anthropic **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`), the fastest and cheapest tier. Called from the existing Express backend with a plain `fetch` (no SDK, so no extra bundle weight). The key lives only in a Render environment variable (`ANTHROPIC_API_KEY`), never in the frontend.
  - **Weight on the site:** the chat panel is lazy-loaded only when an admin opens it, so customer and staff pages and the analytics first paint are unaffected.
  - **Safety:** admin-only (JWT + `requireAdmin`). The model never gets free SQL or write access. It can only request a fixed set of read-only, parameterized reports (sales report, daily series, outstanding balances, refunds, deferred receivables) and then explain or format the results, including a "create report" action that fills the existing report filters and CSV export.
  - **Cost and speed guards:** short context (only the report rows), response length cap, per-admin rate limit, and results cached for the selected date range.
  - You will need to create an Anthropic API key and add it to Render when we reach this step.

### 4.7 Chat page (admin)
- New route `chat` and nav item with unread badge. Thread list shows customer, last message and booking tag (ticket style). Right pane shows the conversation. Floating bubble stays as a shortcut to the same thread (1.8).

### 4.8 Accounts management (Phase 5)
- Admin edits staff: first name, last name, phone, birthday, hire date, role STAFF↔ADMIN, force password reset. Email is not editable. Uses the shared inputs (1.4), a confirmation dialog (1.2), and an audit log entry with before and after values.
- Rule from 2.5 applies when a customer's details change.

### 4.9 Admin dashboard, payments, refunds
- Remaining UI-2 restyles (Dashboard KPIs, Payments, Refunds) using the trigger-safe protocol from the earlier plan (logic hook, shadcn component, flag and rollback).

### 4.10 Cross-cutting for the admin account
- Search bar (1.5), validation (1.4), responsive and theme (1.6), confirmations (1.2), image dialog (1.3).

---

## Part 5. Staff account

| # | Item |
|---|---|
| 5.1 | Search bars work (1.5). |
| 5.2 | Confirmation dialogs on task actions (start, finish, shift toggle, photo upload) (1.2). |
| 5.3 | Service photos open in the global image dialog (1.3). |
| 5.4 | Responsive and theme pass; icons aligned (1.6). |
| 5.5 | Staff see customer name and phone from the live profile for ongoing bookings (2.5). |
| 5.6 | Staff details are edited only by admins (4.8). |
| 5.7 | **Staff terms and conditions on first open** (role-specific, scroll-to-accept): built in 1.11. |
| 5.8 | **Staff UI responsive overhaul** (reported by the owner as a mess; to be fixed later). See below. |

### 5.8 Staff UI responsive overhaul (to be fixed later)
The earlier audit found no horizontal overflow on seeded data, but the owner reports the staff screens are still a mess on real devices, so the plan is to work from real screenshots instead of an automated check alone:
- Collect screenshots of every staff screen on a phone (≈375 px), a tablet (≈768 px) and a laptop, in light and dark, with realistic data: several assigned jobs, a long customer name, three services, photos uploaded, an in-progress job, and a finished job.
- Rework the screens that fail, in this order: **My Jobs / dashboard** (job card layout, header, shift tracker, checklist, the photo boxes, the action row), **job details**, **duty and shift**, **work history** (table to cards on phones), **notifications**, **settings and profile**, and the staff **menu/header** (menu drawer, badges, profile dropdown).
- Principles: one column on phones, tap targets at least 44 px, no more than one primary action per card, short text, evidence boxes only for the current step (already started), sticky primary action where it helps, nothing hidden behind hover.
- Acceptance: each screen reviewed against screenshots at the three widths and both themes, plus a real-device check by the owner.

---

## Part 6. Final verification (all accounts)

- Run all guardrail scripts, the scratch DB suites (ledger, roles, audit, schedule, promo, draft, receivable) and the frontend build.
- Cross-account live test: change something in the admin account and see it in the customer and staff accounts without reload.
- Re-run the Security Advisor and confirm only the known dashboard-only items remain.
- Measure speed again against the 1.1 baseline.

---

## Suggested order of work

1. Part 0.4 hotfix and 0.3 advisor batch 2 (small, independent).
2. Part 1 (shared pieces), starting with 1.1 measurement, 1.2, 1.3, 1.4.
3. Part 2 (email and propagation), since customer and admin both depend on it.
4. Part 3 (customer), which also delivers the wizard for admin.
5. Part 4 (admin), in the order 4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9.
6. Part 5 (staff), then Part 6.

## Added later by the owner (queued, not built yet)
- 3.10 Pay remaining balance pop-up with OCR for customers (spec above).
- 1.11 Role-specific terms and conditions on first open with scroll-to-accept; the Business Hub Terms tab (4.5) edits all three texts.
- 4.3a Admin top-up payment records cash vs digital and flows through ledger, reports, receipts and audit.
- 5.8 Staff responsive overhaul from real screenshots.
- Suggested placement: 1.11 with the Part 2 style shared work (it touches every account), 3.10 next in the customer pass, 4.3a together with 4.1/4.2 (the same payment step), 5.8 right after the admin pass.

## Decisions confirmed by you
1. Cancel in booking creation reads **Cancel** for customer and admin, and deletes the draft after confirmation.
2. The last wizard page differs by role (customer vs admin).
3. Customer OCR is strict. Admin OCR is optional and lenient. Admin payment: Cash or Digital, then Downpayment / Full / Manual (Downpayment and Manual are calculated). Digital needs a reference number, typed or scanned.
4. Upload zone: click and drag, images only.
5. To be received: no input, amount derived from the service total, admin only, counts as an unpaid balance.
6. Reference numbers: **delete every one** in Supabase (past, present and ongoing). Audit logs, accounts and services stay.
7. AI: Claude Haiku 4.5 through the backend, lazy-loaded (see 4.6).
8. No reminder when a booking is made less than 1 hour before its start.
9. Walk-in registration invite is valid for 7 days.

## Carried over from the original plan (nothing is dropped)
The original plan is archived unchanged in `docs/MASTER-PLAN-v1-original.md`. Its finished items are listed at the top of this file. These original items are **not finished** and now have homes here:

| Original item | Where it lives now |
|---|---|
| UI-2 restyles: Dashboard, Payments, Refunds, Customer Billing (trigger-safe protocol: logic hook, then shadcn, then flag/rollback) | 4.9 (admin) and Part 3 (customer billing) |
| Phase 4: admin Chat page | 4.7 |
| Phase 5: admin edit staff details | 4.8 |
| Server does not re-verify booking totals and prices (the client sends the total) | 4.5: DB-side recompute inside `create_booking_atomic_secure` |
| Opening hours ignore minutes | 4.5 |
| Business Hub vehicle-types editor wired into the wizard | 4.5 |
| Remaining inline money sums outside the ledger | Part 6 (guardrail script must report zero) |
| Security advisor "RLS enabled, no policy" info items | left on purpose, re-checked in 0.3 and Part 6 |
| Leaked-password protection and OTP expiry | dashboard-only settings, you toggle them (0.3) |

## Progress log
- **1.1 Speed, first pass (done, on `main`):** measured the main JS bundle at 1,131 KB (268 KB gzipped) because all 41 pages shipped in one chunk. Pages are now loaded per route: main bundle is 204 KB. The customer bookings were fetched and subscribed to up to three times per screen and for admins and staff too; they are now loaded once, and bursts of realtime events become one refetch. Admin booking list no longer flashes to a skeleton on live updates.
- **1.1 still open:** admin booking list loads every booking with nested rows (needs pagination or a server-side projection); remaining per-page realtime channels (38 subscriptions in 19 files) to move behind one hub; Render cold start (keep-alive); a before/after timing on the deployed site.
- Done outside the plan: add-service 500 fix and Security Advisor batch 2 (both applied to production).
- **1.1 Speed (complete, on `main`):** shared realtime hub (one channel per table+filter, resync after hidden tab or back/forward cache), admin booking list loads the latest 150 and everything on demand. Render is on the paid `starter` plan so there is no cold start to fix. Chat channels move to the hub in 1.8. Still to do: before/after timing on the deployed site.
- **1.2 Confirmations (done, on `main`):** `useConfirmAction` over the existing modal with an in-flight lock. Added to technician change, record payment, create account, broadcast, block time, Business Hub saves/publish/add category, payment policy, garage vehicle/fleet saves, password change, staff shift start and job notes, photo removal. Already confirmed before: cancel, refund, verify/reject, reschedule, deactivate, final booking review. Deliberately not confirmed: chat messages, marking notifications read, preference toggles. Not done: a lint rule that fails the build on an unconfirmed mutation (heuristics were too noisy); Part 6 re-audits with `docs`-level checklist instead.
- **1.3 Image preview dialog (done, on `main`):** `ImagePreviewContext` (zoom, gallery, Escape/backdrop close). Receipts, proof of payment and chat pictures use it; no image opens in a new tab. The existing service-photo gallery and QR magnifier were already in-page pop-ups and are unchanged (can be moved onto the shared dialog later). PDF chat attachments still open as a file.
- **1.4 Phone/email validation (code on `main`; migration `20261027000001_contact_rules.sql` written and tested on scratch, awaiting go-ahead for production):** `PhoneInput`/`EmailInput`, shared rules in `utils/contactValidation.js` + `backend/config/contactValidation.js` (parity checked by `scripts/verify-contact-rules.mjs`), backend routes validate, DB triggers normalize/reject changed values. Not yet covered: Landing newsletter box, login/recovery forms (left lenient on purpose), staff edit dialog (4.8 will use the same components).
- **1.4 migration applied to production** (`20261027000001_contact_rules.sql`, three triggers verified).
- **1.5 Search (done, on `main`):** root cause of the dead header search was an undefined `pages` variable in `AdminSearch.jsx`. Shared matcher `utils/searchMatch.js` now used by every page filter. Header searches (admin, customer) also cover plates/vehicles and show "No matches". Not covered: server-side search over very old bookings in the admin list beyond what the list loads (the list loads everything when a search is typed).
- **"speedway" -> "comar" rename (done):** internal storage keys, globals, package names, health name and OCR cache renamed (old theme/preference keys still read once). Production `business_config.gcash_name/payment_account_name` changed from "SPEEDWAY STUDIO" to "COMAR GARAGE" (legacy fallback fields; live QR name untouched). Left alone on purpose: applied migrations, existing test accounts/fixtures, Render service name `speedway-backend` (renaming would create a new service), git remote name `speedwaydeploy`, and the project folder name (yours to rename).
- **1.6 Theme/device/icon polish (first pass done, on `main`):** root cause of left-stuck icons was a global `svg { display:block }`; fixed. Status colours now theme tokens. Automated audit (overflow + contrast + icon alignment) clean for admin and customer at 375/768 in light and dark on seeded data. Still to do in the per-account passes: staff pages could not be signed in on the scratch DB so were fixed by code review only; pages with long real data (tables) need a recheck once the reset script has been run and real bookings exist; mobile service-catalog buttons (4.5) and the walk-in/customer wizard layouts (1.9) are handled in their own items.
- **1.7 Floating chat container (done, on `main`):** bubble clamped to the viewport (8px margin), position remembered (`comar-chat-bubble-position`, stored as fractions), panel flips above/below and left/right to stay fully on screen, re-clamps on resize/rotation. Verified by dragging to the corner and opening the panel at phone width on the scratch DB. Not covered: the admin bubble on booking details only (it is mounted there only; the admin Chat page and shared thread source come in 1.8 / 4.7).
- **1.8 Shared chat data layer (code on `main`; migration `20261028000001_admin_chat_threads.sql` tested on scratch, awaiting go-ahead for production):** `admin_chat_threads()` RPC; ChatContext holds `threads`, derives unread badges, subscribes once via the realtime hub with resync; BookingChat on the hub; admin bubble is global (AdminLayout) and lists conversations with booking tags, back arrow inside a thread. The full admin Chat page (4.7) reuses this context. Not done: an "Open inbox" link from the bubble (needs the 4.7 route).
- **1.9 Booking wizard (code on `main`; migration `20261029000001_booking_drafts.sql` tested on scratch, awaiting go-ahead for production):** drafts (browser + `booking_drafts` table, restore with Start-over banner, deleted on submit/Cancel), Cancel confirms then discards, "Add another vehicle" under the vehicle + success toast, Select Schedule no longer repeats customer details, button label "Cancel" on all four steps. Verified on the customer wizard (restore from browser copy and from server copy, cancel deletes both). Not verified live: the admin walk-in draft (panel state travels with it but was only checked by code). Not part of this item: the role-specific last page (promo code 3.4, terms 4.5, walk-in payment step 4.1/1.10) and OCR rules (1.10).
- **1.9 migration applied to production** (`booking_drafts`, 4 owner-only policies).
- **1.10 OCR, references and payment step (code on `main`; migration `20261030000001_ocr_scan_session_hygiene.sql` tested on scratch, awaiting go-ahead for production):** failed receipts store no reference or read text; abandoned scan sessions are swept and a retried photo is no longer called "reused"; upload zone = click + drag, images only, locked during a scan; admin walk-in defaults to Cash + downpayment, Manual has a minimum/maximum, live "still owes" line, scanned-vs-chosen amount warning. Production reference cleanup: the 5 abandoned scan sessions were deleted (production had no stored payment references and 1 booking); `scripts/sql/clear-reference-numbers.sql` is ready for the clean-slate run after the bookings reset. Customer recipient rule: a receipt with no readable recipient already goes to admin verification instead of being rejected (existing behaviour, confirmed). Not done here: "Receive later / To be received" (4.2) and the typed-or-scanned reference for admin digital payments beyond what already exists (admin can already choose Scan or Type reference).
- **1.10 migration applied to production** (`20261030000001_ocr_scan_session_hygiene.sql`).
- **Part 2 Email, notifications, account data (code on `main`; migration `20261031000001_customer_details_sync_and_invites.sql` and the edge-function changes are tested locally, awaiting go-ahead to deploy):**
  - 2.1 reminder: ~1 hour before start, never with the confirmation; skipped when booked/confirmed inside the last hour; sent to walk-ins by booking email; marked sent only on delivery.
  - 2.2 receipts: confirmation/creation emails attach the newest paid payment's receipt (walk-in downpayments were getting none); added-service payments email their receipt.
  - 2.3 links: every button "VIEW BOOKING DETAILS" -> sign-in -> that booking (`/login?next=`); guarded pages send signed-out visitors to `/login?next=`; `SITE_URL` optional function secret (defaults to https://comargarage.com).
  - 2.4 walk-in registration: 7-day single-use invite, pre-fills name/phone/email, only email locked.
  - 2.5 account details: bookings keep their own copy; open bookings follow account edits (audited); finished bookings frozen; UI/receipts/emails read the booking copy first.
  - Guardrail: `scripts/verify-email-links.mjs` (12 checks). Not testable locally: real email delivery (no Resend) and a full registration through email confirmation.
- **Part 2 migration and edge functions deployed to production** (`20261031000001`; `booking-lifecycle`, `send-notification-email`, `send-refund-receipt` redeployed).
- **Part 3 Customer account (code on `main`; migration `20261101000001_promo_codes_and_terms.sql` tested on scratch, awaiting go-ahead):**
  - 3.1/3.3/3.6/3.7/3.8 were delivered in Part 1 (wizard, image dialog, confirmations, validation/search/responsive, shared chat).
  - 3.2 Create Fleet disabled with a hint until the garage has a vehicle.
  - 3.4 Promo code on the last page (optional): admin-only `promo_codes` table, `redeem_promo_code()` RPC, pricing picks up the redeemed promotion, kept with the draft, validated and counted by the database at booking time.
  - 3.5 Terms come from `business_config.terms_and_conditions` (seeded with the current wording).
  - Needs Part 4: admin screen to create/edit/delete promo codes and edit the terms (4.5); customer balance showing "to be received" amounts (3.9, needs 4.2).
- **Part 3 migration applied to production** (`20261101000001`: `promo_codes`, `redeem_promo_code`, terms text seeded).
- **Staff account fixes (on `main`):** (1) opening a job crashed with "Cannot access 'fetchJobDetails' before initialization" (effect defined above the function it depended on); (2) the staff menu drawer opened by default over the dashboard on phones/tablets. Verified with a real staff sign-in on the scratch database (dashboard, clock-in with the new confirmation, duty, history, notifications, settings, profile, job page). The scratch seed staff user could not sign in (missing auth fields); a real staff user was created through the auth admin API for testing. Other pages flagged by a use-before-define scan only reference functions inside callbacks, so they are safe.
- **Staff "no add image to start the service" (on `main`):** the intake-photo box exists in each job card but sat far below the notes with no hint on the disabled START button. Added a checklist above START (On shift / Before photo added / Scheduled time reached) with an "Add before photo" button; fixed the photo loader so the saved records decide the count even if picture links fail (it previously reported 0 photos, blocking start and re-upload). Open question for the owner: the system flags a no-show 1 hour after the scheduled start (database rule), not 30 minutes; change/configure on request. Real file upload could not be tested locally (no storage service), only the flow around it.
- **Part 5 Staff account (done, on `main`):** 5.1 search (Part 1.5), 5.2 confirmations (clock-in, clock-out, start, finish, notes, photo removal were already covered; photo submission now asks first because submitted evidence is locked), 5.3 photos use the shared image dialog (uploader and evidence gallery), 5.4 responsive/theme pass with the audit tool (disabled Add photos / Update Credentials buttons fixed for light mode), 5.5 customer name and tap-to-call number on every job (booking's own copy), plus the earlier fixes (job page crash, menu drawer, start checklist, photo counts). 5.6 (admin edits staff details) belongs to Part 4.8. Not tested: real photo upload and picture previews (no storage service locally).
- **Staff job card simplified (on `main`):** the completion (after) photo box, its button and warning are hidden until the service is started; before that the card shows only the intake box and the one-line instruction "Add at least one before photo, then start the service."
- **Admin booking details, payment panels merged (on `main`):** "Payment Verification Audit" and "Payment Evidence" are one "Payment Verification" container (audit summary, divider, receipts with verify/reject and archive state). Belongs to 4.3; further 4.3 items (Cancel booking button, grayed empty actions, Release bay button) still to do.
- **4.2 "To be received" (committed locally, awaiting go-ahead to push; migration `20261102000001_receivable_to_be_received.sql` tested on scratch):** a deferred balance is a `RECEIVABLE` payments row the ledger never counts as money. `booking_ledger_v` gains `deferred_amount` and the downpayment gate accepts it. Admin-only RPCs `admin_record_receivable` (amount derived, never typed; walk-in and add-service) and `admin_cancel_receivable` (confirmation on the booking's payments table). Hidden from the customer payment list and the admin payment queue. Still to do: "Deferred receivables" KPI in Financial Reports (with 4.6) and the Statement of Account line.
- **4.3 / 4.3a (committed locally):** admin booking details got a Cancel button (confirmation, then reason), the Unit Collected/release button is now a proper solid button, top-up records Cash or Digital (reference required for Digital, duplicates refused), a "Pay full balance" shortcut, and the Record button is grayed until valid. The Release-bay button restyle and Walk-in/Bookings "Cancel" wording are done; the generic "gray out every empty action" sweep continues in 4.10. Not browser-tested (local servers were not running).
- **4.2/4.3 migration `20261102000001` applied to production and code pushed (1ae5c580).**
- **4.4 Calendar (on `main`):** root cause of the 2 PM-in-1 AM bug: bookings are stored as true instants but the calendar read them with the viewer's device clock (`getHours()`), so any admin device outside Manila saw shifted rows (e.g. a US-Central device showed 2 PM at 1 AM). New `utils/shopTime.js` (`shopDateString`, `shopHourValue`, `shopWallToDate`, fixed UTC+8) now places bookings in the calendar, the month dots, the hour filter, the 3-day fetch window and the scheduling grid. Regression script `scripts/verify-shop-time.mjs` (14:00 row, 23:30/00:30 day boundary). Layout: on desktop the month calendar column is sticky and the day timeline card is the only scrolling region. Verified: page loads without errors and the sticky column computes correctly; not tested on a non-Manila device in the browser.
- **4.4 Calendar pushed (db48a427).**
- **4.5 Business Hub (committed locally; migrations `20261103000001` role terms, `20261103000002` purge deactivated promos, `20261103000003` enforce opening hours tested on scratch, awaiting go-ahead to push):**
  - **Terms tab + 1.11 gate:** per-role versioned texts in `business_config`, `accept_terms()` / `publish_terms()` (audit-logged), a first-open pop-up in all three layouts with scroll-to-accept (checkbox hidden until the end; sign out is the only other exit), customer wizard no longer asks again once accepted. Verified in the browser with the scratch admin (gate appears, accepts, does not return; editor and disabled Publish).
  - **Service Catalog mobile layout:** selection tools moved to their own row, Archive/Restore/Delete wrap in a grid (checked at 390 px, no horizontal scroll).
  - **Promos:** new Promo codes card (create with validation and confirmation, status badges, usage, real delete with confirmation, audit entries) verified end to end on scratch; promo delete is now a **real delete** (backend no longer tombstones; old leftovers purged by migration). The global "capitalize first letter" input listener was mangling code and reference fields, so those inputs opt out.
  - **Refund hub:** "Excess payment" reason hides the deduction input and forces the deduction to 0 (also for queued booking excess).
  - **Propagation audit:** `scripts/sql/verify-hub-propagation.sql` (changes each Hub setting in a rolled-back transaction and asserts the DB rule follows: downpayment rates, closed weekdays, advance window, lead time, closures, hours, terms, promo codes). Found and fixed: opening hours were not enforced by the database at all (now enforced for customers, minutes included, admins exempt). One deliberate known gap remains in the script: below the minimum total the screens say "pay in full" but the database accepts the percentage as the work-start gate.
  - **Not done in 4.5:** server-side recompute of booking totals. It needs the service catalog in the database (today it exists only in the app and `business_config.custom_services`), so it is a larger piece that should be planned on its own.
- **4.5 migrations applied to production and code pushed (e77ef24d).**
- **Bay capacity follow-up (on `main`):** the Hub input still exists: Schedule Rules → "Total Bays Available" (`slots_per_hour`); it feeds the database (`slot_has_capacity`), the backend slot validation and the wizard/admin screens (`settings.MAX_BAYS`). Changes: removed the hard-coded 7/15 bay constants and the unused fleet-capacity helper (wizard now starts from the live value), clarified the input text (it is also the most vehicles one booking can include), added bay checks to the propagation audit, and a guardrail in `verify-single-source.mjs` against hard-coded bay numbers. `max_vehicles_per_staff` exists in the table but the current database capacity function ignores it, so it is NOT exposed in the Hub (it would be a dead setting); making it real means deciding how staff on duty limit capacity. Correction: the capacity function already refused slots outside operating hours; the 4.5 migration added the same rule to the shared schedule helper so every path agrees.
- **Technician capacity (committed locally; migration `20261104000001_technician_capacity.sql` tested on scratch, awaiting go-ahead to push):** a slot holds the lower of the bays and vehicles-per-technician x technicians, where technicians = active STAFF accounts (minimum 1, the roster, not who is clocked in, so future slots never look full because nobody has clocked in yet). New `shop_capacity()` is the single source; the database capacity check, the backend slot validation and the screens (effective capacity in `ConfigContext`/`bayCapacityOf`, schedule rules) all read it. Business Hub › Schedule Rules gets "Vehicles per Technician" with a live line ("N active technicians now, so X vehicles at a time"). This reverses the earlier rule (migration 20261022000005) that bays were the only limit. Audit script covers it; verified in the browser on scratch.
- **Technician capacity code and migration `20261104000001` committed (5262b49c); 4.6 below (committed locally, migration `20261104000002_report_deferred_receivables.sql` tested on scratch, awaiting go-ahead to push):**
  - **Blank print fixed.** Root cause: the app-wide receipt print rule (`body * { visibility: hidden }`, only `#printable-receipt` shown) hid the whole report. The report is now `#printable-report`, shown in print, and the fixed-height app shell is released so it flows onto several pages. Verified by applying the print rules to the live page (report visible, sidebar hidden, content flows); a real print dialog was not available to test.
  - **Old analytics view removed:** `AdminSalesReport.jsx`, its toggle link and its allowlist entry deleted; `/admin/finance/classic` redirects to `/admin/finance`.
  - **Deferred receivables KPI** in the reports (`sales_report` now returns `deferred_receivables`), plus an "of this, ₱X is marked to be received" line on the customer Statement of Account (shared receipt model gets `deferredAmount`; the emailed PDF does not show the line yet).
  - **AI assistant:** backend `POST /api/admin/analytics-assistant` (admin only) in `backend/services/analyticsAssistant.js`: Claude Haiku 4.5 over plain `fetch`, fixed read-only tools run as the signed-in admin (sales report, daily series, outstanding bookings) plus two page actions (set date range, export CSV), 700-token cap, 4 tool rounds max, per-admin 12/min limit, 60 s cache, 503 with a clear message when no key. Frontend: lazy-loaded "Ask AI" panel (own ~1.7 kB gzip chunk, loaded only when opened) with quick questions; it can fill the report's date range and trigger the CSV export. `scripts/verify-analytics-assistant.mjs` runs the whole tool loop against the scratch database with a fake model server (real `sales_report` as admin, unknown tool refused, actions, 503/400/429). **Needs from you:** an Anthropic API key added as `ANTHROPIC_API_KEY` on Render (already listed in `render.yaml`). It has not talked to the real model.
- **Technician capacity and 4.6 migrations applied to production and code pushed (e0731722).**
- **AI assistant needs no paid key (owner has no budget for one):** without `ANTHROPIC_API_KEY` it runs a free built-in mode (`backend/services/analyticsBuiltIn.js`): it reads a period ("today", "last week", "last 14 days", "this month"…) and an intent (earnings, compare periods, who owes, best/worst day, create report, export CSV), runs the same read-only tools, and writes the answer from the real figures; anything else gets a short list of what it can answer, never a guess. With a key it switches to Claude Haiku 4.5 for free-form questions. Verified by `scripts/verify-analytics-assistant.mjs` (built-in answers, actions, no model call).
- **4.7 Admin Chat page (on `main`):** new `/admin/chat` page (`pages/Admin/AdminChat.jsx`) and a "Chat" sidebar item with an unread badge. Left: every conversation from `admin_chat_threads()` through the shared `ChatContext` (customer, last message preview, time, unread count, booking tag chips like `#10000000`), search by customer/message/booking and an All/Unread filter. Right: the existing `BookingChat` for that customer (its booking-tag selector keeps the ticket-style context; messages show "Re: #booking"). Deep links `?customer=<id>&booking=<id>`. Desktop opens the newest conversation; phones show the list first with a Back button. The floating bubble stays on every other admin page as a shortcut and is hidden on the Chat page itself. Verified in the browser on scratch (threads, unread badge, tag chips, opening a thread marks it read, mobile list/convo flow, no horizontal scroll); realtime delivery could not be tested (no realtime service locally).
- **4.7 restyle (on `main`):** sidebar item renamed "Message Inquiries"; the page has no big header any more (accessible title only) and is a full-bleed workspace like the owner's mock-up: conversation list on the left (circular avatars, aligned search field and All/Unread pills, selected-row marker), conversation on the right with the sender header. Colours come from theme tokens (checked in dark and light); phones show the list first, then the conversation with a Back arrow; no horizontal scroll; fills the screen exactly with no page scrollbar.
- **4.7 spacing pass (on `main`, e045943d):** list rows, filters, avatars and the conversation header now have proper spacing; the messages panel sits in a padded, rounded frame under the header.
- **4.8 Admin edits staff details (committed locally; migration `20261105000001_staff_details.sql` tested on scratch, awaiting go-ahead to push):** an **Edit** button on every staff/admin row opens a pop-up (no new page): email shown but locked; first name, last name, PH mobile (shared `PhoneInput`), birthday, hire date, role (STAFF/ADMIN), and "Require a password reset". Two steps in the same pop-up: form, then a "Review changes" list (before → after, with a role warning) and "Confirm and save" (the app's confirmation dialog cannot sit above a modal, so the review step is the confirmation). Backend `PATCH /api/admin/staff/:id` (admin only) validates everything again, ignores no-ops, refuses email edits, refuses self-role changes and Default Admin demotion, relies on the database guards (last admin, staff with active services) mapped to 409, sets `must_change_password` and emails a recovery link on a forced reset, and writes `STAFF_DETAILS_UPDATED` with before/after to the audit log. Migration adds `profiles.birthday` and `profiles.hired_at` (hire date backfilled from account creation; only admins may change it). Role lock reasons are shown in the pop-up. Shared dialog/sheet layers now sit above the floating chat bubble. Verified: `scripts/verify-staff-edit.mjs` (auth, validation, normalisation, no-op, self-role guard), promote/demote/force-reset by hand, and the whole pop-up flow in the browser (desktop and 390 px) including the audit entry; the reset email itself was not delivered (no email service locally).
- **Admin booking details: "Finish service" button removed (committed locally).** Finishing a unit needs the technician's completion photos, which an admin cannot realistically add, so it is done from the staff account only. The admin card now shows a read-only "SERVICE FINISHED" tag for completed units (the unused start/finish code was deleted).
- **4.8 follow-up: "Allow viewing reports" toggle (committed locally, in the same unpushed migration `20261105000001`):** new `profiles.can_view_reports` (default off, admin-only column like role and hire date). Shown in the Edit pop-up for staff accounts only, listed in the review step ("No → Yes"), saved through `PATCH /api/admin/staff/:id`, audit-logged. Nothing reads it yet: what staff may see is to be configured later (see the open design item below).
- **Open design item:** define what "staff may view reports" exposes (which reports, whether money figures are hidden) and wire `can_view_reports` to the staff navigation and report data policies.
- **All migrations applied to production; code pushed (1aa22fb4); edge functions redeployed.** The staff "Edit" pop-up did not appear on the live site at first because Vercel never started a build for that push; an empty commit (cfbc49b7) re-triggered it and the live bundle now contains the pop-up and no longer has the admin "Finish service" button. The backend route `PATCH /api/admin/staff/:id` was still returning 404 on Render about 12 minutes after the push (the assistant route from the earlier deploy is live), so saving from the pop-up cannot work until Render finishes deploying; check the Render deploy log if it stays that way.
- **4.9 Dashboard / Payments / Refunds (checked, no restyle done):** audited at 375 px in dark and real light mode: no horizontal overflow on Dashboard, Payments, Refunds, Bookings, Walk-in or Audit Logs, and no real contrast defects (the audit's light-mode hits came from switching the theme attribute without reloading). The money on these screens already comes from the ledger, and the payments table, refunds (with the new Excess payment option) and dashboard counters behave correctly. A shadcn rewrite of these three screens would only change looks while putting the verify/reject/refund triggers at risk, so it is parked unless the owner wants it for the thesis visuals.
- **4.10 Admin cross-cutting pass (on `main`):**
  - **Search:** every admin search box already used the shared matcher except the Accounts list (Staff/Admin tabs), which now matches name, email and phone in any word order, case and phone format. Found and fixed an app-wide bug while testing: the global "capitalise the first letter" listener changed the field value in a way that stopped React from firing `onChange` for the first letter of typed, pasted or single-event input, so search boxes (and other fields) silently stayed unfiltered. It now assigns through the prototype setter; verified by typing into the accounts search.
  - **Confirmations:** audited every admin mutation button. Reject/verify payment, refunds, assign technician, deactivate, undo no-show, business settings, broadcast and the new staff edit were already confirmed; added the missing one for "Mark all notifications as read" (also grayed out when nothing is unread).
  - **Image dialog, validation, responsive/theme:** no private lightboxes remain in the admin pages (the one `window.open` is the receipt print window); admin phone and email fields use the shared inputs; responsive/theme checked in 4.9. Added a missing label on the schedule grid's refresh icon button.
- **4.10 pushed (1c717ea8).**
- **3.10 Pay remaining balance (committed locally; migration `20261106000001_submit_balance_payment.sql` tested on scratch, awaiting go-ahead to push):**
  - **Customer page:** booking details shows **Pay remaining balance (₱X)** under the balance bar and in the billing card while the booking is open and has a payable balance (amount = ledger `submitted_balance_due`, i.e. minus anything already sent for verification). The old inline QR block is gone; once a payment is waiting it says "Your payment of ₱X is waiting for the shop to verify".
  - **One pop-up (`components/payments/PaymentProofModal.jsx`, shared):** amount due, the shop's QR (enlargeable) and account name/number, receipt zone (click or drag, images only, one scan at a time, scanning state), OCR result, collapsible tips, terms checkbox only when the current customer terms were not accepted, Cancel/Send. Closing discards an unsent upload. Result rules: below the balance → blocked with "The receipt shows ₱X, but your balance is ₱Y"; equal → accepted; more → accepted, "₱Z kept as credit"; fee shown ("₱925 shown, ₱905 after fees counts"); duplicate receipt/reference → blocked; unreadable → manual verification allowed; recipient mismatch → blocked.
  - **Database `submit_balance_payment(booking, scan)`:** customer owns the booking, booking open, balance taken from the ledger (never the browser), scan current/unused and made for exactly this balance, below balance refused, reference single-use, scan consumed; creates ONE payment FOR_VERIFICATION (type Full, GCash, net amount recorded, fee recorded) that appears in the admin queue and the booking's verification container, with the existing audit entry and admin notification. `scripts/sql/verify-balance-payment.sql`: 13 checks pass (other customer, below, exact, over, stale scan, unknown scan, reuse, duplicate reference, manual review, ledger pending, scan consumed).
  - **Backend:** the OCR route takes an optional `rateKey` (per-booking rate limit) and is called without a booking id, so nothing is persisted until the database function runs.
  - **Verified in the browser** (scratch DB, phone and desktop, OCR response mocked because the scratch has no storage service): PDF rejected without scanning, scanning state, low receipt blocked with the message, good receipt accepted with fee and excess note, Send creates the payment, page switches to "waiting", dialog fits 390 px. The real Tesseract reading of a real photo was not tested.
- **Production bug found and fixed (Tailwind sources):** utility classes are generated only for `components/ui` and `features`. The Message Inquiries page lives in `pages/Admin`, so its utility classes (`h-11`, `border-l-[3px]`, `sm:p-5`, …) were missing from the production CSS even though it looked right in the dev server. `AdminChat.jsx` and `components/payments` are now explicit `@source` entries. Rule: new Tailwind-styled UI belongs in `features/` or must be added as a source in `styles/ui.css`.
- **3.10 migration `20261106000001` applied to production; pop-up now shows the shop's configured QR at full size (tap to enlarge) with account name and number; pushed (e97899fc). Frontend and chat styling confirmed live.**
- **Login bug fixed and pushed (7432730e):** the access watchdog in `AuthContext` compared the live `role_version` with a profile that had not loaded yet (read as 1), so any account whose role had ever been changed (role_version above 1: staff promoted from a customer, anyone edited with the new role control) reloaded the page endlessly on every load. It now waits for the profile. Found while reviewing the staff screens with a seeded staff account (role_version 3).
- **5.8 Staff responsive overhaul (on `main`):** reviewed every staff screen (dashboard, my jobs, job details, work history, duty, notifications, profile, settings) with a seeded staff account (three jobs, a 43-character customer name, a 2-letter name, three services, one in progress) at 375, 768 and 1280 px, in dark and light, with an in-page audit for overflow, tap targets and text size. Fixes: job card header wraps on phones (the status badge and schedule used to be pushed off the right edge; plate and job chips wrap, long model names break); tap targets of at least 44 px (menu, close-menu, bell, account menu, save-notes, settings theme and action buttons, all labelled for screen readers); no text under about 11.5 px across the staff screens, evidence boxes and shared headers; job card padding tightened on phones. Result: no horizontal overflow, no tap target under 44 px and no text under 11 px on any staff screen at 375 and 768 px; desktop has no overflow. The owner's real-device check (acceptance) is still to do.
- **Part 6 Final verification (run on the day of 5.8; results):**
  - **One command:** `node scripts/verify-all.mjs [--db <scratch container>] [--skip-build]` runs the five guardrail scripts (single source, email source 98 checks, email links 12, contact rules, shop time), backend syntax checks, the production frontend build (plus a check that Tailwind-only pages have their CSS) and the scratch-database suites. Last run: 11/11 (without the build) and 14/14 earlier including it.
  - **Scratch suites:** Business Hub propagation 29 checks pass (downpayment, schedule rules, closures, hours, bays, technicians, terms, promo codes; one documented known gap: below the minimum total the database accepts the downpayment percentage instead of forcing full payment); balance payment 13 checks pass (made independent of leftover test data). The older ad-hoc probes (receivable, drafts, roles, audit) were exercised while they were built; they have no pass/fail assertions and were not re-run.
  - **Cross-account live updates:** production's realtime publication contains every table the app subscribes to (`bookings`, `payments`, `notifications`, `booking_messages`, `booking_vehicles`, `business_config`, `blocked_slots`). A real two-account live test needs a realtime service, which the scratch database does not have, so it was checked structurally, not by watching one account change another.
  - **Security Advisor (production):** 177 findings before, 140 after the search_path fix: remaining are 45 "anon can execute SECURITY DEFINER" (34 of them trigger functions), 95 "authenticated can execute SECURITY DEFINER" (the RPCs the app calls) and leaked-password protection (Dashboard toggle). Migration `20261107000001` pinned the one function with a mutable search_path (applied). Migration `20261107000002` (revoke EXECUTE on the 34 trigger functions; proved on scratch that triggers keep firing) is written and tested but NOT applied: 0.3 says to ask before changing production. "Multiple permissive policies" (35) no longer appear in the security list.
  - **Speed vs the 1.1 baseline:** first-load JavaScript was 1,131 KB (268 KB gzipped) in one bundle; it is now 641 KB raw / 185 KB transferred (main 224 KB, React 165 KB, Supabase 208 KB, icons 45 KB), pages and heavy libraries load on demand (the report charts and PDF library only when opened, the AI panel only when opened). The site's HTML answers in about 0.2 s; the backend health check answers in about 0.1 s warm, but the first request after a deploy took 22 s (the new instance starting), which is the remaining cold-start cost.
  - **Production data check (read-only):** 3 bookings, 4 payments, 1 stored reference number, 91 audit rows, 2 admins, 3 active staff, 4 customers, 0 promo codes, terms versions 1/1/1, capacity 3 (3 bays, 4 per technician, 3 technicians); no account has a changed role (so the endless-reload login bug had not affected anyone yet). The clean-slate reset (0.2) has NOT been run.
- **Trigger-function revoke (`20261107000002`) applied to production on request:** 34 SECURITY DEFINER trigger functions are no longer executable by anon/authenticated. Security Advisor now: 13 anon + 63 authenticated "SECURITY DEFINER executable" (the login-lock, registration, admin-check and app RPCs, kept on purpose) and the leaked-password toggle (Dashboard only).

## Follow-up round (owner's checklist after Part 6)
- **Owner actions confirmed done:** clean slate, leaked-password protection, real-device checks and live two-account tests.
- **No-show grace:** stays at 1 hour (existing database rule), no change.
- **Analytics is now Reports (`/admin/reports`):** old `/admin/analytics`, `/admin/finance`, `/admin/finance/classic` redirect there. New **Bookings** tab (any date range up to 93 days, totals, vehicles, services, money per booking) from the admin-only database function `bookings_report(from,to)` (migration `20261108000001`), with a PDF export (landscape A4). The assistant answers "bookings on October 5", "today / tomorrow / yesterday", "this week / month", and "make a PDF of the bookings" in the free built-in mode (no API key needed); the optional Claude mode has matching tools.
- **Statement of account:** shows "Of this, ₱X is marked to be received by the shop." when part of the total is deferred to the shop. Edge functions need a redeploy to carry it.
- **Server-side booking price check (migration `20261109000001`):** the database re-prices every booking from the catalog and custom services and rejects totals below the lowest legitimate price (promos considered). Property test: 320 browser-priced bookings across 8 promo setups all pass. The add-service backend route uses the same catalog price.
- **Staff Reports (recommendation, not yet built):** a Reports page for staff limited to operations: the schedule (today/tomorrow), job counts by status and their own completed jobs. No money figures and no other staff's data, gated by the existing per-account "can view reports" switch, enforced in the database, not only in the screen.
- **Restyle:** Dashboard cards and queue, and the Payments and Refunds action buttons use shadcn components; handlers, calculations and confirmations are unchanged.
- **Staging:** tooling is ready (`scripts/staging/`, `render.staging.yaml`, `docs/STAGING.md`). Blocked until a Supabase project slot is freed (free plan allows 2 active projects).

## Booking details round: digital payments, adding services, receipts
- **Admin digital payment = the receipt.** "Digital" shows the reference box with a small Receipt upload button. The receipt is read by the same OCR as the customer flow; the amount, fee, reference and receipt picture are stored from the scan (migration `20261110000001`, `admin_record_scanned_payment`, admin-only, scan used once, refuses more than what is owed). If a receipt is not accepted (or the customer does not want to use it) **"Enter by hand"** swaps to a typed reference and amount. A receipt that is not accepted never stores its reference.
- **Adding a service now works one way everywhere (migration `20261111000001`).** The server decides the price and the duration from the shop catalog (durations are now in the database), re-checks the payment minimum from the ledger and, for a customer, that the longer booking still fits the hours and bays. `apply_added_service` does the whole change in one locked step: service line, payment, receipt scan, new total and end time, audit entry.
- **Admin add-service:** Digital reads the receipt (or "Enter by hand"); Cash and "to be received" unchanged.
- **Customer add-service (new):** "+ Add a service" on a scheduled/confirmed booking before work starts: pick the vehicle and service, see the new total and the amount to pay now, then pay through the same QR + receipt pop-up as the remaining balance. The payment waits for admin verification; the amount counted already includes payments waiting for verification so it cannot be paid twice.
- **Receipt reading fixes:** "Reference ID" labels no longer keep the "ID" word; a GCash receipt that prints Amount + Fee = Total Sent is read as the amount (not amount minus the fee twice); digit "repair" of references now needs 70% digits (it was rewriting real letters). New `scripts/verify-ocr-parser.mjs` is part of `verify-all`.
- **Booking details wording/layout:** payment status no longer repeats the amount on the same row; refunds have receipts (admin transactions table and customer billing); receipt dropdown when there are several payments.
- **Open question (not built):** one technician per booking is how the database works. Per-vehicle technicians would need a new column and changes to staff tasks and capacity.

## Per-vehicle technicians (migration `20261113000001`, committed, not yet applied to production)
- **Model:** each vehicle has its own technician (`booking_vehicles.staff_id`, the column already existed and was unused). The booking's technician (`bookings.staff_id`) is kept as the "lead" (the first assigned vehicle) so older code keeps working. Setting the booking's technician assigns every vehicle; clearing it clears them all; a vehicle added later inherits it. Existing bookings are backfilled when the migration runs.
- **What now works per vehicle:** staff see and photograph only their own vehicles; workload limit counts vehicles and uses the Business Hub number (the old trigger had a fixed 3 while the setting said 4); the lock after a before photo; notes; the "has active work" protection against deactivating a technician; no-show/cancel/reschedule clearing; audit entries ("Changed Honda CRV from A to B").
- **Backend:** staff tasks return only the vehicles assigned to the caller; a technician can start or finish only their own vehicle; a booking is confirmed (and can start) only when every vehicle has a technician; each technician gets their own task notice; the staff directory counts work per vehicle.
- **Screens:** vehicle cards each have a technician dropdown, plus "Assign all vehicles to…" when there is more than one vehicle; the header shows one name, or a dropdown "Technician - Vehicle" when they differ; the customer sees a technician per vehicle; dashboard/bookings "unassigned" now means any vehicle without a technician; scheduling grid shows a booking in each technician's row.
- **Tested:** `scripts/sql/verify-per-vehicle-technicians.sql` (16 checks, in `verify-all`) plus the backend routes with two technician accounts.

## To do: make the landing page contact form work
- **Finding:** the "Contact Us" form on the public landing page (name, email, message) is only a design. Its submit does nothing (`onSubmit` just prevents the page reload), so a visitor's message is lost.
- **Plan:**
  1. Store each submission in the database (visitor name, email, message, time, read/handled state), with a simple limit per visitor to stop spam, and no sign-in needed.
  2. Show the messages to the administrator in a "Website Inquiries" list (new count badge, mark as handled, reply by email link). Keep it separate from the customer booking chat in Message Inquiries.
  3. Notify the active administrators (in-app, and email to the shop address) when a message arrives.
  4. Show the visitor a clear confirmation or error, with the same email and message length rules used elsewhere.
- **Done when:** a message sent from the landing page appears for the administrator within a minute, a repeated or oversized submission is refused, and the visitor sees the result.
- **Paper:** once built, add "Inquiry Form" back to the Contact item of the Public Landing Page in the scope.

## To do: automatic logout after inactivity
- **Finding:** there is no idle timeout. A signed-in session stays open until the user signs out or the sign-in token expires, so a shared or unattended shop computer stays signed in as an administrator or technician.
- **Plan:**
  1. Track inactivity (clicks, typing, scrolling, touch) in the signed-in app. After the idle period, show a short warning ("You will be signed out in 60 seconds") with a "Stay signed in" button, then sign out and return to the login page with a message.
  2. Idle period by role: shorter for administrator and staff (they handle money and customer data; proposed 15 minutes), longer for customers (proposed 60 minutes). Keep the values in one place so they can be changed.
  3. Work across several open tabs: activity in one tab keeps every tab signed in, and a sign-out in one tab signs out all of them.
  4. Do not lose work silently: if a form has unsaved changes (for example the booking wizard or a payment being recorded), keep the warning visible for the full countdown, and keep the existing draft saving where it exists.
  5. Record automatic sign-outs in the audit log for administrator and staff accounts.
- **Done when:** an idle admin, staff, and customer session each end after their configured time, the warning appears and "Stay signed in" resets it, two tabs stay in step, and the login page explains why the user was signed out.
- **Paper:** once built, add "automatic termination of inactive sessions" back to the security requirements (REQ-NFR-33 in the old numbering).

## Done: staff "joined" date and invitation password rule (migration `20261114000001`, committed, not yet applied to production)
- The "Date joined" in the admin's Edit Staff pop-up is now read-only. The database sets it (shop time zone) at the moment an account becomes a staff or administrator account (invitation, or a role change into staff/admin); moving between staff and administrator keeps it. The server refuses attempts to change it.
- The "Force user to change password on first login" checkbox is removed from the staff/administrator invitation. A first-login password change is now always required.

## Final features queued by the owner (to be built, in this order)
1. **Automatic deactivation of inactive accounts** after a number of days or months chosen by the administrator.
   - A setting in the Business Hub (a number plus days or months, and on/off). A daily job deactivates accounts with no sign-in and no booking activity for that long, writes each one to the audit log, and sends the customer a warning email first.
   - Deactivation never deletes data. Open bookings, unpaid balances, and the last administrator are protected from being deactivated.
2. **Print today's report:** a "Print today" button in Reports that produces one printable page (PDF) for the current day: bookings of the day, payments received by method, refunds, outstanding balances, and technician workload. Built from the existing bookings report and financial report.
3. **Staff Reports (enable):** a Reports page for staff, shown only when the administrator turns on "Can view reports" for that account (the switch already exists in Edit Staff and defaults to off). Recommended content: operational data only (today's and tomorrow's schedule, their own jobs by status and completed counts), no money figures and no other technician's data, enforced in the database.
4. **Book for customer, from chat (admin sends an invitation):**
   - The administrator sends an "invitation" message with a button in the booking chat. When the customer taps it, the booking details saved on the customer's own device (the draft) are sent to the shop, tied to that chat and that customer, readable only by the administrator, valid for a limited time, and usable once.
   - The administrator opens "Book for customer": the walk-in booking form opens with all the draft details filled in and the customer's existing account already selected. The slot and prices are re-checked when it opens, because they may have changed.
   - The customer gives the payment receipt photo to the administrator (chat, message, or in person); the administrator drags it into the receipt reader of the walk-in form and submits. The receipt reader's strict rules still apply to the receipt, but the administrator can use the manual entry option.
   - Feasible: the draft transfer is a short-lived server copy that the customer sends deliberately; nothing is read from the customer's device without their tap.
   - Questions to settle before building are listed in the owner conversation (who is invited, expiry, what if no draft exists, what is copied).

## Final features: built (committed; migrations 20261115 to 20261118 not yet applied to production)
- **Services can only be archived:** every Delete button and its logic for services (single and bulk) is removed from the Business Hub. Services that were deleted earlier stay hidden as before. (FAQ entries can still be deleted; they are not services.)
- **Automatic deactivation of inactive staff (`20261115000001`):** an on/off switch plus "after N days/months" on the Staff Roles page (off by default). A daily job (every 24 hours, and shortly after the server starts) in the backend deactivates a STAFF account with no sign-in for that long (a never-signed-in or just-reactivated account counts from its joined date), skips staff with active work, never touches administrators, writes the audit log, and marks the account. A deactivated account is a customer account again (history kept). Only an administrator can reactivate it ("Reactivate" button in the same panel); no email is sent.
- **Print today's report (`20261116000001`):** "Print today's report" in Reports makes a plain-language PDF of any length: a summary sentence and five boxes, money received by method, each payment, refunds, every booking of the day (who booked it, phone, vehicles and services, technician for each vehicle, total/paid/owed), and the balances still to collect. The bookings report now also names each vehicle's technician.
- **Staff Reports (`20261117000001`):** a "Reports" page for staff appears only for accounts where an administrator turned on "Can view reports" (one switch per staff account, off by default). It shows only the technician's own vehicles for today and tomorrow, job counts (today, week, month, all time) and the last finished jobs; no money, nobody else's work. Enforced in the database.
- **Book for customer from chat (`20261118000001`):** the administrator taps "Ask for booking details" in a customer's chat; the customer sees a card with "Send my booking details" and, after confirming, the booking saved on their account/device (without payment) is sent to the shop (valid 24 hours, used once, readable only by administrators and that customer). On the card, the administrator taps "Book for customer": the walk-in form opens with those details and the customer's account already chosen (it asks before replacing an unfinished walk-in). The customer hands the receipt photo to the administrator, who uploads it in the form as usual. Customers with accounts only.
- **Tests:** `verify-all` now has 21 checks (adds staff reports 6, booking draft invites 12).
