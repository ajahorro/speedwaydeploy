# Plan: One Source of Truth per Concept + Admin Chat + Staff Editing

## Context
Each concept (money paid, receipts, shop config, downpayment) is computed separately by many consumers instead of being read from the record or event that produced it. As a result:
- **Money:** there are 9 separate "paid" formulas outside SQL and about 14 inline sums in the frontend. Nothing in the frontend calls the canonical SQL `booking_financial_ledger`.
- **Receipts:** there are 4 receipt builders with different formulas. The email resolver counts the transfer fee; the SQL ledger excludes it.
- **Admin verification:** two admin screens verify payments with different write semantics.
- **Business Hub:** some changes never reach booking creation:
  - closures always fail with a 403 because the request has no auth header
  - deleted built-in services come back
  - the catalog and promos are read from stale localStorage
  - vehicle types are never read
  - downpayment is hard-coded in both JS and SQL
- **Missing features:** there is no admin chat inbox and no way for an admin to edit staff details.
- **Security holes:** several endpoints trust `userId` from the request body.

**Goal:** each concept has one authoritative producer, and every consumer reads that producer's output (DB function, view, or RPC). Consumers do not recompute. This also cuts load time, because N+1 client-side assembly is replaced by bulk server projections.

**Decisions made with the user:**
- Transfer fee does **not** count toward settlement; only net received counts. This matches the current SQL.
- Receipts: a per-transaction receipt for each verified payment, **plus** a cumulative paid-to-date statement on final settlement. Both are built from the ledger.
- Downpayment becomes a **Business Hub setting** stored in `business_config`.
- Admins can edit staff **name, phone, birthday, joined/hire date, role STAFF↔ADMIN, and force a password reset**. Email is not editable.

## Principle: source-of-truth map (target)

| Concept | Single producer | Consumers must… |
|---|---|---|
| Booking money (paid, refunded, balance, credit, pending, settled) | SQL `booking_financial_ledger` / new bulk `booking_ledger_v` | read it; never sum `payments` themselves |
| Downpayment requirement | SQL `booking_required_downpayment(total)`, which reads `business_config` | call it, or read `required_downpayment` from the ledger |
| Payment transaction amounts (gross, fee, net) | `shared/receiptModel.ts` (one definition, also used by the backend) | import it |
| Payment verification | RPC `admin_override_payment_to_paid` (extended) | both admin screens call it |
| Lifecycle emails and receipts | `booking-lifecycle` edge function only | legacy routes removed or redirected to it |
| Shop config (hours, bays, closures, catalog, promos, vehicle types, downpayment) | `business_config` single row + `blocked_slots`, read through one `get_shop_config()` RPC | ConfigContext is the only client reader; no localStorage as truth |
| Booking acceptance (capacity, hours, closures, lead time, price) | SQL `create_booking_atomic_secure` | the client check is advisory only |

---

## Phase 0 — Safety fixes (small, ship first)
Blocked-slot auth header:
- In `frontend/src/pages/Admin/BusinessHub.jsx` (lines ~814 and ~860), add the Bearer token to the blocked-slots calls.
- Copy the pattern from `PromoManager.jsx:340`.

Backend: derive the actor from the JWT instead of trusting the body (`backend/server.js`):
- `/api/staff/toggle-shift` (:3751) and `/api/staff/update-preferences` (:3819): use `getLifecycleActor` (:201) and require `actor.profile.id`. Ignore body `userId`.
- `/api/admin/profiles` (:2711):
  - add `requireAdmin` (:273)
  - select explicit columns, dropping `email_change_temp`
  - send the token from `AdminAccountsManagement.jsx:41` and `AdminUserManagement.jsx:37`
- `/api/auth/request-email-change` (:2579) and `/confirm-email-change` (:2666):
  - require a JWT and use `user.id` and the profile email from the DB
  - drop body `userId` and `oldEmail`
- Update the frontend callers in `AuthContext.jsx:471-500` to send the token.

## Phase 1 — Money: one ledger
**New migration `supabase/migrations/20261024000001_canonical_ledger_bulk.sql`:**
1. `business_config` gets these columns:
   - `downpayment_min_total` (default 1000)
   - `downpayment_rate` (0.30)
   - `downpayment_high_threshold` (2000)
   - `downpayment_high_rate` (0.50)

   Add a unique singleton guard: a `singleton boolean default true unique` check, after deduplicating to the lowest id.
2. `booking_required_downpayment(p_total numeric) returns numeric`: stable, reads `business_config`, and replaces the hard-coded 30%/50% in:
   - `create_booking_atomic_secure` (`20261021000009:140-141`)
   - `staff_booking_has_verified_downpayment` (`20261023000001`)
3. Extend `booking_financial_ledger` with `required_downpayment`, `downpayment_met`, and `paid_status` (`unpaid|pending|partial|paid|overpaid|refunded`) so badges stop being derived in JS. Keep the existing keys.
4. New **view `booking_ledger_v`** (`security_invoker = true`, so RLS applies): one row per booking with the same columns as the ledger, computed set-based (grouped over `payments`). List and report pages fetch it with `.in('booking_id', ids)` or join it.
5. `payment_net_received(p payments)`: an SQL helper for the per-row value `coalesce(nullif(detected_amount,0), amount)`. Used by the ledger, the view, `process_booking_refund_v2` (`20261022000002:61-75`), and `admin_cancel_booking` (`20261023000002:58-80`). The cancel refund must stop counting `FOR_VERIFICATION` as refundable settled money; report it separately instead.
6. Make `booking_verified_paid` delegate to `booking_net_paid` so the credit trigger uses the same rule.

**Backend (`server.js`):**
- Delete `calculateNetPaid` (:86) and `calculateVerifiedPaid` (:103).
- Add one helper, `getLedger(bookingIds[])`, that queries `booking_ledger_v` with the service role.
- Replace these call sites with it:
  - :4570, :4770, :4829
  - :5039: staff tasks become a bulk query that checks `downpayment_met`
  - :5098, :5243, :5319
  - the no-show sweep at :4167
- Staff eligibility = `downpayment_met`, the same rule SQL uses for photo RLS.

**Frontend:**
- `frontend/src/services/ledgerService.js` (new):
  - `fetchLedger(bookingId)` and `fetchLedgers(ids)`, both reading the view
  - a `useBookingLedger(s)` hook that subscribes to `payments` realtime and refetches
- Reuse the existing unused `bookingService.js:508` `fetchBookingFinancialLedger`, `describeLedgerState`, and `hasPendingVerification`. Move them into this service.
- Reduce `utils/paymentUtils.js` to **presentation only**: it maps ledger fields to labels and badges.
  - Remove `calculatePaymentSummary` and `getRequiredDownpayment`.
  - The only pre-insert calculation left is a downpayment *preview* in the wizard, which calls the RPC `booking_required_downpayment`.
- Replace every inline sum with ledger fields:
  - `AdminDashboard.jsx:179,250`: revenue becomes Σ `net_settled` (or a new `admin_revenue_summary(from,to)` RPC)
  - `AdminSalesReport.jsx:97-118`: an RPC `sales_report(from,to)` returning gross, refunds, net, and count from the same helper
  - `AdminRefunds.jsx:80-118`: `net_settled` and `refunded_amount`, plus the queued credits it already reads
  - `AdminPayments.jsx:232,349`
  - `AdminBookingDetails.jsx:947,1182,1235,1243`
  - `CustomerBilling.jsx:49-55`
  - `CustomerBookingDetails.jsx:254,295-299`
  - `CustomerMyBookings.jsx:227` and `hooks/useBookings.js:25`
  - `ActiveBookingContainer.jsx:126-130` and `UnifiedContext.jsx`: attach the ledger rows in bulk
  - `hooks/useAdminBookings.js:42`
  - `BookingSummaryHeader.jsx` (`derivePaymentStatusBadge`)
- Delete the dead `utils/paymentAmounts.js`.

**Verification unification:**
- Extend `admin_override_payment_to_paid` (`20261018000001:234-301`) so it keeps the declared amount: add a `verified_amount` column and stop overwriting `amount`. Also add `p_reject boolean` / `p_reason` or a sibling `admin_reject_payment` RPC.
- After it runs, reconcile happens through one backend call.
- `AdminBookingDetails.jsx:464,514,525` (verify, reject, force-confirm) must call the same RPCs as `AdminPayments.jsx:190`, through a shared `services/paymentVerificationService.js`.
- Remove the direct `payments.update` fallbacks in both files.

## Phase 2 — Receipts and emails: one builder per document
- **Transaction amounts:** `shared/receiptModel.ts` is the only definition.
  - Fix its net fallback to `amount` so it matches the ledger.
  - Have the backend import it (compile `shared/` to JS, or port it as `shared/receiptModel.js` with the TS re-exporting it).
  - Delete `backend/services/transactionAmounts.js`.
  - The receipt number is `RCP-<payment id>` everywhere.
- **Booking amounts in emails:** `supabase/functions/_shared/bookingEmail.ts::resolveAmounts` (:154-185) is replaced by a call to `booking_financial_ledger` (service role). This removes the transfer-fee credit and adds refund subtraction. `isSettled` in `booking-lifecycle/index.ts:274,313` becomes `ledger.fully_settled`.
- **Documents** (all in `officialReceiptPdf.ts`, mirrored in `OfficialReceipt.jsx`):
  - `TransactionReceipt`: attached to a new `payment_verified` lifecycle event, sent once per payment. Idempotency key is `booking_id+event+payment_id`, so add a nullable `payment_id` to the `booking_email_deliveries` unique key.
  - `StatementOfAccount` (cumulative): every settled row, refunds, and credits from the ledger. Attached on the `fully_settled` event and shown at `/customer/receipt/:id`, replacing the booking-level "invoice" that looked like a receipt.
- **Triggering:**
  - The reconcile endpoint (:5098) emits `payment_verified` for the payment it was given.
  - It emits `booking_settled` when `fully_settled` flips to true, even if the status is unchanged. This fixes the missed final receipt.
- **Legacy routes:** remove `/api/emails/payment-receipt` (:962), `/api/emails/booking-confirmation` (:861), the dead `/api/emails/status-email` call (:2821), and `buildReceiptPdfBuffer` (:590).
  - Keep `/send-email` only for non-booking templates.
  - Point `notificationService.js:166` (legacy invoke) at `booking-lifecycle`.
  - Have `send-refund-receipt` use the ledger.

## Phase 3 — Business config: one reader, enforced at the DB
- **RPC `get_shop_config()`** (security definer, readable by `anon` and `authenticated`): returns the singleton `business_config` (hours with minutes, bays, closed weekdays, lead and advance limits, `enforce_capacity`, downpayment fields, `vehicle_types`, the **resolved** service catalog, active promos) plus upcoming `blocked_slots`.
  - The resolved catalog is built server-side by merging built-ins, `custom_services`, and the deleted/archived lists, checking both the plain id and the per-vehicle id.
  - **Move `SERVICES_DATA` into a seed of `custom_services`** (a migration that seeds once if empty), so the DB holds the whole catalog and the built-in/tombstone special cases go away.
  - Add `business_config` and `blocked_slots` to the `supabase_realtime` publication.
- **ConfigContext** (`frontend/src/context/ConfigContext.jsx`):
  - becomes the only client reader: it calls `get_shop_config()`, refetches on realtime and on window focus, and exposes everything above
  - `parseHour` keeps minutes
- **Remove localStorage and window caches as sources of truth:**
  - `servicesCatalog.js:227-280,385-389,453-491`: `getServiceCatalog` and `getPromoRules` take their input from the context
  - `ConfigContext.jsx:76-83`
  - `BusinessHub.jsx:563,1003,1850`
  - `PromoManager.jsx:105`
  - backend `inMemoryPromoCache`
- **Remove hard-coded fallbacks:**
  - `config/constants.js` `SHOP_CONFIG` bay and hour numbers and `VEHICLE_TYPE_OPTIONS`
  - `rules.js SCHEDULE_DEFAULTS`
  - `bookingHelpers.js:93`
  - `CustomerBookAppointment.jsx:16-30` (rebook from `SERVICES_DATA`)

  On a config load failure, show a blocking error rather than silently using the wrong defaults.
- **Replace direct `business_config` selects with the context:**
  - `bookingService.js:105`
  - `Step1Schedule.jsx:48`
  - `Step2Services.jsx:69,225`
  - `Step3FleetEditing.jsx:34,65`
  - `CustomCalendar.jsx:47`
  - `DateTimePicker.jsx:57`
  - `scheduleService.js:111`
  - `server.js:3526,3638,3705`
- **Server-side enforcement in `create_booking_atomic_secure`:**
  - recompute the total from the catalog and promo in the DB, and reject on mismatch
  - check `blocked_slots`, `closed_weekdays`, lead time, and the advance window
  - make capacity count bays per vehicle, and use the same end-time rule as the client (longest vehicle + buffer, buffer stored in config)

  Then the client `validate-slot` call is advisory only. Fix the client to compute duration the same way, by sharing one `computeBookingWindow()` in `domain/schedule/rules.js`, which the backend `scheduleValidation.js` already uses.
- **Business Hub UI:** add a "Payments" section with the downpayment fields, and a vehicle-types editor that the wizard now reads.

## Phase 4 — Admin Chat page
- Route `chat` in `frontend/src/main.jsx` (~:139). Add a nav item in `AdminLayout.jsx navGroups` (Core Operations) with a `MessageCircle` icon and a badge from `globalUnreadCount`.
- New `frontend/src/pages/Admin/AdminChat.jsx`, a two-pane inbox:
  - **Left:** the thread list from a new RPC `admin_chat_threads()` (one row per `customer_id` with last message, time, unread count, and customer name; admin-only, security definer), plus search.
  - **Right:** the existing `BookingChat` (`components/BookingChat.jsx`) with `customerId` and an optional booking context selector (the customer's bookings).
  - Uses `ChatContext.openChatForCustomer` (:174) and `threadUnread` for live badges. Realtime updates go through the existing `global-chat-unread` channel, and the list refetches on INSERT.
- Mount `FloatingBubbleChat` in `AdminLayout` and give it a "No thread? → Open inbox" link. No new RLS is needed (`20261022000010` already allows admin reads).

## Phase 5 — Admin edit staff details
- **Migration:**
  - `profiles` gets `birthday date` and `hired_at date` (backfilled from `created_at`)
  - extend `guard_profile_privileged_columns` so only admins can change `hired_at`
- **Backend:** `PATCH /api/admin/staff/:id`, built on `requireAdmin` and following the `/api/admin/revoke-access` pattern (:3226).
  - Updatable fields: `first_name`, `last_name`, `phone_number`, `birthday`, `hired_at`, and `role` (STAFF↔ADMIN only). Role changes rely on the existing triggers: `guard_admin_lifecycle`, last/default admin protection, and active-services protection (`20261022000011`). Surface their errors as 409.
  - `force_password_reset: true` sets `must_change_password` and sends a recovery email (reuse the existing recovery/invite mail path).
  - Write `writeAuditLog` with a before/after diff.
- **Frontend:** in `AdminAccountsManagement.jsx`, add an "Edit" action per row that opens a modal form. Show the joined date. On save, refetch.

## UI track — shadcn/ui adoption (runs alongside the logic phases)

**Current state:**
- `frontend/` is Vite 5, React 18, plain JS (`.jsx`).
- Styling is hand-written CSS plus inline `style={{}}`, with design tokens as CSS variables in `src/index.css` (`--admin-brand`, `--admin-card`, `--admin-radius`, …) and light/dark handled by `context/ThemeContext.jsx`.
- No Tailwind, no `@/` alias, no `components/ui`. shadcn needs all three.

**Rule: when a page gets new UI.** A page is restyled with shadcn **only in the same change that rewires its data to the single source of truth**. That avoids touching any page twice and avoids a big-bang restyle. Pages untouched by the logic phases keep their current CSS until a later pass.

### When shadcn is used: timeline with gates
| Step | When | What shadcn is used for | Gate before moving on |
|---|---|---|---|
| **UI-0** | Right after Phase 0 (security fixes), before any Phase 1 screen work | Install only. No existing page changes. | Build passes. Before/after screenshots of 10 key pages are identical. |
| **UI-1** | First Phase 1 screen: Financial Reports | Full page rebuild, including **`chart-area-interactive`** | KPI totals equal `sales_report` RPC and dashboard; trigger checklist (below) passes |
| **UI-2a** | Rest of Phase 1: Dashboard KPIs, Payments, Refunds, Customer Billing | Cards, tables, dialogs | Trigger checklist per page |
| **UI-2b** | Phase 3 | Business Hub Payments and Vehicle Types sections | Saving in the hub is visible live in the wizard |
| **UI-2c** | Phases 4–5 | Admin Chat page and staff edit dialog (new UI, nothing to migrate) | Feature tests |
| **Later (not in this plan)** | After all of the above is stable | Booking details, wizard, staff pages | Separate plan |

### Trigger-safe migration protocol (applied to every restyled page)
Existing buttons are what fire the lifecycle changes: verify, reject, refund, assign, status change, save config. Swapping the UI must not change *what* they do. Every page follows these steps:
1. **Inventory first.** Before touching the page, list every interactive control: label → handler → RPC/endpoint → side effects (audit log, notification, email, reconcile). Record the list in the PR description. Example for AdminPayments: Verify → `handleVerifyPayment` → `admin_override_payment_to_paid` → reconcile → `TASK_ASSIGNED` notice → `payment_verified` email.
2. **Separate logic from markup (no visual change).** Move the handlers into a hook (e.g. `hooks/admin/usePaymentActions.js`) that returns `{ verify, reject, refund, pending }`. Ship this commit alone and test that the old UI still behaves identically.
3. **Swap presentation only.** The new shadcn component calls the *same* hook functions. No handler code is written inside the component.
4. **Keep the safeguards.** Every destructive or irreversible action uses `AlertDialog` (confirm). Buttons are disabled while `pending` so a double-click can't double-submit. Keep the existing toasts and error paths.
5. **Run both UIs side by side behind a flag.** Use `VITE_UI_V2` or a per-admin toggle in localStorage, with the old page component kept for one release, so it can roll back instantly without a deploy.
6. **Checklist sign-off.** Exercise each inventoried control in the new UI and confirm the same DB rows, audit entries, notifications and emails are produced (compare against the old UI on a test booking). Then delete the old component.

### UI-0 Foundation (after Phase 0, before Phase 1 frontend work)
- Install Tailwind v4 with the `@tailwindcss/vite` plugin. Add the `@` → `src` alias in `vite.config.js` and a new `jsconfig.json`.
- Run `npx shadcn@latest init` with `components.json` set to `"tsx": false` (JS output), `"rsc": false`, aliases `@/components/ui` and `@/lib/utils`.
- **Avoid breaking the existing pages:**
  - import Tailwind's `theme` and `utilities` layers but **not preflight** globally. Base resets go inside a `.ui-scope` wrapper, or are omitted.
  - map shadcn's tokens onto the existing ones in `index.css`, so new and old UI share one palette (single source of truth for design too):
    - `--primary` → `--admin-brand`
    - `--card` → `--admin-card`
    - `--border` → `--admin-border`
    - `--radius` → `--admin-radius`
    - `--background` / `--foreground` → the admin bg/text vars
  - `ThemeContext` toggles the `.dark` class that shadcn expects, in addition to what it does today.
- Add a base component set: `button card table badge tabs dialog sheet select input label form calendar popover dropdown-menu skeleton separator tooltip sonner chart`.
  - The `chart` component adds Recharts. Add `@tanstack/react-table` for the data table.
  - Keep `react-hot-toast` for now, and migrate toasts later.
- Add a `vendor-ui` manual chunk (recharts, radix) in `vite.config.js` so the admin bundle doesn't bloat customer pages. Load the report page with `React.lazy`.
- Done when `npm run build` passes and a smoke check shows existing pages render unchanged in light and dark.

### UI-1 Financial Reports page — the main rebuild (with Phase 1)
- `/admin/analytics` and `/admin/finance` both render `pages/Admin/AdminSalesReport.jsx` (506 lines: inline styles, raw `amount` sums, print CSS).
- Replace it with `pages/Admin/FinancialReports/`:
  - `FinancialReportsPage.jsx`: the shell, with shadcn `Tabs` for **Overview | Transactions | Refunds & Credits | Outstanding**. Split the routes: `/admin/finance` is the full report and `/admin/analytics` is the Overview tab.
  - `ReportFilters.jsx`:
    - date-range `Popover` + `Calendar`
    - a `Select` for method (cash/GCash/bank) and status
    - presets (today, 7d, month, custom)
    - filters stored in the URL search params
  - `KpiCards.jsx`: `Card`s for Gross collected, Transfer fees (informational), Net received, Refunds, Net revenue, Outstanding balance, Pending verification, Customer credit liability, and Avg ticket. **Every number comes from the new `sales_report(from,to)` RPC.** That RPC is built from `payment_net_received` / `booking_ledger_v`, so these figures match the dashboard, booking details, refunds and emails exactly.
  - **`RevenueAreaChart.jsx`** replaces the hand-built block/bar "STRATEGIC GROWTH TREND" chart (`AdminSalesReport.jsx:334-362`, divs sized by `height: %`).
    - Add it with `npx shadcn@latest add chart-area-interactive`; the JS output comes from `tsx:false`.
    - Adapt it:
      - two stacked series, **Net received** (`--chart-1` = brand red) and **Refunds** (`--chart-2`)
      - optionally a third dashed series for **Pending verification**
      - the block's built-in time-range `Select` (7d / 30d / 90d) is wired to the page's `ReportFilters` instead of local state, so chart, KPIs and table always show the same range
      - the tooltip shows ₱ amounts formatted by the shared `MoneyAmount` formatter
    - Data comes from a new `sales_report_daily(from,to)` RPC (one row per day: net_received, refunds, pending, txn_count), built on `payment_net_received`. The chart therefore can't disagree with the KPI cards.
    - The current "revenue forecast" (`forecastData`, :147) becomes a dashed projection series computed from the same daily rows, or is dropped if it isn't needed for the thesis.
  - Other block charts on the page (top services, method mix) become shadcn `chart` bar/pie variants fed by `sales_report` output.
  - **Performance fix that comes with the rebuild:** the current page fetches one `profiles` row per payment (N+1, :72-79). The RPCs return customer names joined server-side.
  - `MethodBreakdownChart.jsx`: donut by payment method.
  - `TransactionsTable.jsx`:
    - TanStack + shadcn `Table`, server-paginated from `payments` joined to the ledger view
    - columns: date, booking, customer, method, gross/fee/net, status `Badge`, verifier
    - a row click opens a `Sheet` with the transaction receipt (`OfficialReceipt` in transaction mode)
  - `OutstandingTable.jsx`: bookings with `outstanding_amount > 0` from `booking_ledger_v`.
  - **Export:** CSV from the same RPC rows. For print/PDF, keep a print stylesheet scoped to the report (port the current `@media print` block) or use the existing `html2pdf.js`.
  - Use `Skeleton` loading states. One RPC call per tab replaces the current client-side aggregation, which also makes the page load faster.

### UI-2 Pages restyled when their logic is rewired
| Page | Restyled in | Main shadcn pieces |
|---|---|---|
| `AdminDashboard.jsx` (revenue/refund KPIs) | Phase 1 | `Card` KPIs and a small `chart`, reusing `KpiCards` from UI-1 |
| `AdminPayments.jsx` (verification queue) | Phase 1, verification unification | `Table`, a `Dialog` for verify/reject, `Badge` for OCR match |
| `AdminRefunds.jsx` | Phase 1 | `Table`, `Sheet` for refund details, `Form` for the amount |
| `CustomerBilling.jsx` + `/customer/receipt/:id` (Statement of Account) | Phase 1 / Phase 2 | `Card` summary, `Table` ledger, receipt `Dialog` |
| Business Hub "Payments" (downpayment) + vehicle-types sections | Phase 3 | `Form`, `Input`, `Select`, `Switch` |
| `AdminChat.jsx` (new) | Phase 4 | built in shadcn from the start: `ScrollArea`, `Input`, `Badge`, `Avatar`, `Resizable` panes. `BookingChat` is wrapped as-is at first. |
| Staff edit modal in `AdminAccountsManagement.jsx` | Phase 5 | `Dialog` + `Form` (react-hook-form + zod), `Calendar` for birthday and hired date, `Select` for role, `AlertDialog` for force reset |

`AdminBookingDetails` and the customer booking wizard are **not** restyled in this plan, because they are large and high-risk. Only their data wiring changes. Shared money UI goes into `components/finance/` (`MoneyAmount`, `PaymentStatusBadge`, `LedgerSummary`) and all of it is fed by ledger fields, so every page shows money identically.

## Execution order and risk control
- **Order:**
  - **Phase 0** first.
  - **UI-0** next.
  - **Phase 1:** migration, then backend, then screens in this order:
    1. Financial Reports (UI-1)
    2. Dashboard
    3. Payments
    4. Refunds
    5. Customer billing
    6. all remaining inline-sum fixes, with no restyle
  - **Phase 2**, then **Phase 3**.
  - **Phases 4 and 5:** independent, and can run in parallel with 2 and 3.
- Each phase is its own branch and commit set. Migrations are additive and existing ledger keys are kept, so old clients keep working during rollout.
- **Guardrail script:** add `scripts/verify-single-source.mjs` (modelled on `scripts/verify-email-source.mjs`). It greps `frontend/src` and `backend` and fails if any of these appear:
  - `.reduce(` over `payments`
  - `from('business_config')` outside ConfigContext or the RPC
  - `localStorage` keys `speedway_custom_services` or `speedway_promo_rules`
  - imports of the removed helpers

  Wire it into the npm test/lint script.

## Verification
1. `supabase db reset` (local) applies every migration cleanly. Then run SQL assertions comparing `booking_financial_ledger(id)` and `booking_ledger_v` for seeded scenarios:
   - downpayment only
   - full pay
   - two installments
   - OCR net < declared, with a fee
   - partial refund
   - overpayment
   - cancelled with no fee
   - admin cash walk-in
2. For each scenario, the following must show identical paid, balance, and credit values:
   - customer list, detail, and billing
   - admin detail, payments, refunds, and dashboard
   - sales report
   - the email (dry-run `booking-lifecycle` locally with `supabase functions serve`)
   - the receipt PDF
3. Staff eligibility: a booking with a verified downpayment shows in `/api/staff/tasks`. Lowering the Business Hub downpayment rate changes eligibility and the wizard preview without a reload.
4. Business Hub:
   - add a closure (now 200) → the slot is blocked in the wizard and DB insert is rejected
   - delete a built-in service → it is gone in another browser
   - edit a price → it shows live in an open customer tab
   - add a vehicle type → it appears in the wizard
   - tamper the total in devtools → the booking is rejected
5. Run `node scripts/verify-single-source.mjs` and `node scripts/verify-email-source.mjs`, the existing frontend tests/build (`npm run build` in `frontend/`), and the backend tests.
6. Admin chat: a customer sends a message → it appears in `/admin/chat` with an unread badge, the admin replies, and the customer sees it live.
7. Staff edit:
   - edit name, birthday, and joined date → shows in the list, and an audit row exists
   - demote the last admin → 409
   - force reset → the user is gated at next login
8. Security: calling `/api/staff/toggle-shift` with another user's id, or with no token, → 401/403.
9. UI:
   - after UI-0, untouched pages (wizard, booking details, staff pages) look identical in light and dark (screenshot them before and after in the browser pane)
   - Financial Reports KPIs for a date range equal the sum of `booking_ledger_v` for the same bookings and match the dashboard numbers
   - CSV export totals match the KPIs
   - print preview works
   - at 375px width there is no horizontal page scroll; tables scroll inside their own container
