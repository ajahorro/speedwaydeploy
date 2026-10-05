# Account-Tier Architecture and Cross-Account Data Flow

## Scope and reading guide

This report follows the application from sign-in and role routing through the customer, staff, and admin workflows, including the shared database records, backend APIs, notifications, chat, evidence storage, and lifecycle rules. It is based on the frontend routes and services, `backend/server.js`, and the Supabase migrations in this repository. The database migrations are the authority for persisted schema and RLS policy behavior; the frontend is not itself an authorization boundary.

The product has three operational account tiers:

| Tier | Profile role | Main route area | Primary purpose |
|---|---|---|---|
| Customer | `CUSTOMER` | `/customer/*` | Maintain a garage, request service, pay, track bookings, and communicate with the shop. |
| Staff | `STAFF` | `/staff/*` | Work on assigned vehicle units, record service progress/evidence, and manage duty status. |
| Administrator | `ADMIN` | `/admin/*` | Run shop operations, manage accounts/catalog/schedule, verify transactions, assign work, and audit lifecycle activity. |

“Account tier” here means the role in `public.profiles.role`; it is not a separate subscription or billing level.

## 1. Application and identity architecture

### Frontend composition

`frontend/src/main.jsx` mounts the application under `ConfigProvider`, `ThemeProvider`, `AuthProvider`, `ChatProvider`, `UnifiedProvider`, `BrowserRouter`, and `UIProvider`. The three role layouts are protected route parents:

* `/admin` requires `ADMIN`.
* `/staff` requires `STAFF`.
* `/customer` requires `CUSTOMER`.
* Public entry points include `/`, `/login`, `/accept-invite`, `/auth/callback`, and `/password-confirmation`.

The role pages and nested routes are listed in the account-tier sections below. Shared layout features include role-specific navigation, notification counts, profile/settings entry points, and sign-out.

### Identity join

1. Supabase Auth authenticates a user and issues a session/JWT.
2. The Auth user UUID is used as `profiles.id`; frontend `AuthContext` loads that row by `id`.
3. `profiles.role`, `profiles.is_active`, and `profiles.must_change_password` control application routing and account state.
4. `ProtectedRoute` waits for initialization/profile hydration, redirects unauthenticated users, blocks users whose role is not allowed, and presents the forced password-change gate before granting access to a role area.
5. Backend privileged handlers independently validate the bearer token with Supabase Auth and resolve the corresponding profile. The admin helper requires the `ADMIN` role; lifecycle actor resolution admits active `ADMIN` or `STAFF` profiles. Endpoint-specific checks then narrow access further.

The UI guard is a navigation/UX control. Requests can still be made outside the UI, so backend identity/role checks and database RLS are essential. They are not uniform across every legacy endpoint; see “Observed boundaries and caveats.”

### Shared providers

* `AuthContext` maintains the Auth user and hydrated profile, handles session bootstrap/sign-in/out, account recovery/deactivation state, login throttling capability, and staff shift actions.
* `UnifiedContext` loads customer bookings and notifications for the signed-in user. It refreshes on booking, booking-vehicle, payment, and notification Realtime changes.
* `ChatContext` enables the chat interface only for active `ADMIN` and `CUSTOMER` profiles. A customer has one chat thread keyed by `customer_id`; a message can additionally carry a `booking_id` as context.
* `ConfigProvider` supplies business configuration used by schedule/service UIs. `UIProvider` supplies shared dialogs/toasts.

## 2. Account-tier capabilities and data scope

### Customer

Customer routes:

* `/customer` — customer dashboard.
* `/customer/book` — multi-step appointment/service/vehicle/schedule/payment submission.
* `/customer/bookings` and `/customer/bookings/:id` — booking list and booking detail.
* `/customer/billing` and `/customer/receipt/:id` — transaction ledger, payment status, and receipt.
* `/customer/garage` — owned vehicles, vehicle service history, and fleet groups.
* `/customer/notifications` — account notifications.
* `/customer/profile`, `/customer/settings` — profile and account/security preferences.

Customer-owned records are normally selected using the current Auth UUID as `customer_id` or `owner_id`, with RLS policies providing an additional database boundary. Customer booking detail cross-references its booking UUID to vehicle units, service lines, payments, and the assigned technician name. The technician name is obtained through the restricted `get_customer_booking_technician` RPC rather than exposing the whole staff profile.

Garage entries are stored separately in `vehicles` and are tied to the customer through an owner/profile identifier. A customer may group garage vehicles in `fleet_groups`; group membership is represented by `fleet_group_vehicles`, while vehicle and booking snapshots carry a `fleet_group_id` where applicable. A customer’s fleet group is not the same thing as a booking: the appointment creates booking-specific vehicle-unit and service-line rows so the service record can preserve what was requested at that time.

Customers see status, service, and payment changes through their booking/child-row subscriptions and in-app notifications. Customer cancellation is routed through an authenticated backend path; payment/refund amounts are presented from the payment ledger and related refund/credit data rather than being inferred only from a booking status.

### Staff

Staff routes:

* `/staff` — assigned-work dashboard, task counts, announcements, and shift timer.
* `/staff/tasks` — active vehicle assignments.
* `/staff/history` — completed/past work.
* `/staff/job/:id` — unit-specific technical/service detail and evidence.
* `/staff/duty` — clock in/out.
* `/staff/notifications`, `/staff/profile`, `/staff/settings` — staff account functions.

The assignment key is `bookings.staff_id = profiles.id`. Staff task reads go through `GET /api/staff/tasks`, which verifies the bearer token and active `STAFF` profile, queries only bookings assigned to that profile, excludes closed bookings, joins only the fields needed for operational work, and checks verified payment eligibility before returning active assigned work. A `vehicleId` or `bookingId` query narrows the same authorization scope; it does not grant access to another worker’s booking.

The returned task projection contains booking/unit operational context (booking ID/status/times and total amount, plus vehicle-unit ID, make/model/plate/type, fleet-group indicator, service notes/timestamps, and service names) rather than the full customer booking/payment/profile record. The backend separately reads payment rows to determine eligibility but does not return those payment records in the task payload. `/staff/job/:id` resolves its unit through the same staff endpoint. This is the boundary intended to implement “staff can view assigned vehicle details only.”

Staff can change a unit to `IN_PROGRESS` or `COMPLETED` through `POST /api/bookings/update-status`. The backend checks that the staff actor is the current `staff_id`, the unit belongs to the supplied booking, the booking is not terminal, and the unit is in an allowed state. Starting work also checks assignment, schedule date/time, and verified downpayment. Completion is subject to service/evidence gates enforced across backend and SQL migrations. Unit-level `service_notes` and `service_photos` are the technical record.

Before/after service photos use `service_photos` plus the private `service-proofs` object bucket. Object paths use `<booking_id>/<booking_vehicle_id>/<phase>/<file>`. The DB records the path and metadata; the UI requests short-lived signed URLs. Current RLS rules scope reads to the owning customer, assigned staff with verified downpayment, or admin; staff upload rules additionally bind the actor to the assigned booking/unit, payment eligibility, valid phase/status, and evidence gate. Retention tracks archival/purge state and legal-hold exemption.

Staff duty state is represented by profile fields such as `is_clocked_in` and `clock_in_timestamp`. The task dashboard uses assignment and notification Realtime events to refresh. Work history is derived from booking/unit lifecycle records rather than an independent assignment identity.

### Administrator

Admin routes:

* `/admin` — operational dashboard/priority queue.
* `/admin/business` — business hub for operational configuration, services/catalog, promos, and related settings.
* `/admin/walk-in` — admin-created on-site booking.
* `/admin/bookings`, `/admin/bookings/:id` — all-booking directory and full operational detail.
* `/admin/schedule` — schedule/occupancy, blocked slots, and promo controls.
* `/admin/payments`, `/admin/refunds` — payment verification and refund workflow.
* `/admin/analytics` and `/admin/finance` — sales/reporting.
* `/admin/audit-logs` — audit trail.
* `/admin/accounts`, `/admin/users` — staff/admin account management and customer directory/history.
* `/admin/settings`, `/admin/notifications`, `/admin/profile` — configuration, broadcast/notification management, and own profile.

Admin booking detail cross-references the booking row to its customer profile, assigned staff profile, vehicle units and services, payments, schedule, and audit history. Admin booking/payment screens can see broader operational fields than customer or staff screens. Admins assign staff, add services, manage no-show/cancellation/reschedule transitions, verify/reject payments, generate receipts, process refunds, and inspect customer/staff history.

Admin-created walk-ins can be guest bookings or linked to a customer profile. Booking creation attempts to resolve an existing customer by normalized email if no explicit customer ID is supplied, avoiding an orphaned booking when a registered customer is entered. For admin walk-ins, the admin actor’s own Auth ID must not accidentally become the booking’s `customer_id`. The admin walk-in payment path can record on-site payment directly; customer digital payments instead enter verification with OCR/receipt metadata.

Account management provisions or elevates staff/admin accounts through admin-only server/RPC paths. Invitations set a role and can require a first-login password change. Deactivation is designed to preserve history and prevent removal while staff have active services or when the protected/last admin rules apply.

## 3. Shared data model and cross-references

The following is the operational join graph. UUIDs are the primary cross-account join keys unless stated otherwise.

| Entity | Identity / important references | What it connects and who uses it |
|---|---|---|
| `profiles` | `id` = Supabase Auth user UUID; `role`, `is_active`, name/contact, duty and account flags | Role/account identity; referenced as customer, staff, uploader, verifier, notification recipient, chat sender, and audit actor. |
| `bookings` | `id`; `customer_id` → `profiles.id`; `staff_id` → `profiles.id`; schedule/status/financial snapshots | Root service transaction. Customer and admin workflows use it broadly; staff access is filtered by assigned `staff_id`. May retain guest name/email/contact when no customer profile is linked. |
| `booking_vehicles` | `id`; `booking_id` → `bookings.id`; optional `fleet_group_id`; unit status and vehicle details | A distinct vehicle unit within one booking. Staff job URLs use this unit ID; staff updates must match both unit ID and booking ID. |
| `booking_vehicle_services` | `booking_vehicle_id` → `booking_vehicles.id`; service identifiers/names, price/duration/snapshot fields | Requested service lines for each unit. Price snapshots protect the agreement from later catalog edits. |
| `vehicles` | customer owner/profile ID; optional `fleet_group_id` | Customer’s reusable garage inventory; used to prefill booking units. It is distinct from the booking-time snapshot. |
| `fleet_groups` / `fleet_group_vehicles` | group `owner_id` → customer profile; membership joins group and garage vehicle | Customer fleet organization, available in booking preparation and operational vehicle categorization. |
| `payments` | `booking_id` → `bookings.id`; optional `verified_by` → profile; receipt/OCR/reference/payment status | Submitted, verified, cash, digital, and refund transactions. Payment state contributes to booking eligibility, balance/credit, confirmation, and refund calculations. |
| `customer_credit_ledger` | customer and booking references, entry type/amount | Tracks credits/overpayment/refund-queued amounts separately from payment transaction rows; customer-readable and admin-managed under policies/RPCs. |
| `payment_refund_allocations` | payment/refund and booking/payment links | Allocates refund amounts to the source transaction/booking; prevents ambiguous partial-refund accounting. |
| `notifications` | `user_id` → recipient profile; optional `booking_id`; optional `entity_id`; type, action URL, read state | In-app cross-tier event delivery. Task assignment notices target staff; booking/status/payment notices target customer/admin recipients depending on event. |
| `booking_messages` | `sender_id` → profile; denormalized `customer_id`; optional `booking_id` | One customer conversation thread, with booking context optionally attached to a message. Current chat is limited to active customer/admin users. |
| `service_photos` | `booking_id`, `booking_vehicle_id`, `uploaded_by` profile; storage path, phase | Before/after evidence shown to customer, assigned worker, and admin subject to current RLS and storage policies. |
| `audit_logs` | actor name/role plus event/detail; some event records reference domain IDs in structured details | Operational trace for payment, assignment, account, staff duty, and other audited actions. Admin can review the logs; user-scoped reads may also be allowed by policy. |
| `blocked_slots`, `business_config`, catalog/promo records | schedule dates/configuration; service and promo identifiers | Shared shop-wide capacity, operating hours, bays, pricing, service, and promotion policy consumed by customer booking and admin scheduling. |
| `booking_email_deliveries` | booking/event/idempotency key and delivery state | Prevents duplicate booking lifecycle email/receipt sends. |
| `ocr_scan_sessions` | server-issued scan/session identifier associated with receipt validation/payment flow | Connects the uploaded receipt/OCR verdict to the payment submission and server-side validation; OCR is not trusted merely because a browser sends a result. |

### Main data joins, expressed as the system uses them

* Customer → booking: `bookings.customer_id = profiles.id` (or a guest booking with contact snapshots and no profile link).
* Staff → assigned booking: `bookings.staff_id = profiles.id`.
* Booking → unit: `booking_vehicles.booking_id = bookings.id`.
* Unit → service lines: `booking_vehicle_services.booking_vehicle_id = booking_vehicles.id`.
* Booking → money: `payments.booking_id = bookings.id`; related credit/refund allocations are consulted for net financial state.
* Booking/unit → evidence: `service_photos.booking_id` and `service_photos.booking_vehicle_id`; actual photo bytes are addressed by the corresponding private storage path.
* Booking → staff assignment notice: notification `user_id = bookings.staff_id` and `booking_id = bookings.id`; notification user ID alone does not prove the assignment is still current.
* Message → customer thread: `booking_messages.customer_id = profiles.id`; message `booking_id` is contextual, not the thread identity.
* Garage vehicle → fleet: owner and `fleet_group_id` / membership relation; booking units preserve service-specific details separately.

## 4. End-to-end lifecycle and account handoffs

### A. Service selection and appointment creation

1. A customer chooses vehicle units, services, optional package/promo, and time. Admin may use the same wizard in walk-in/admin mode.
2. The frontend validates vehicle/service prerequisites and bay/duration needs, and calls backend slot validation. A client-side network failure is distinguished from an authoritative capacity rejection.
3. `bookingService.createBooking` normalizes customer identity, checks that there is at least one unit, validates service prerequisites and shop capacity, computes discounts/package totals, and snapshots prices/promo details.
4. Booking, unit, service, and initial payment state are written through the atomic `create_booking_atomic` DB function (with later migration fixes/hardening). It prevents partial “master booking without children” writes and checks database capacity under contention.
5. Digital receipt payment requires a server OCR scan/session and a verdict. A valid but not yet human-verified payment enters verification; a mismatch/rejected scan is not treated as paid. Cash customer payments remain pending; admin walk-in payments may be recorded as paid on site.
6. Lifecycle email/notification processing is event-driven, with delivery idempotency tracked by booking/event records.

### B. Payment verification → assignment readiness

1. Admin payment view queries non-cash `payments` with the parent booking, customer, sibling payments, units, and services; it applies the audit-compliance filter.
2. Verification compares the submitted amount and available OCR amount/reference with booking total, required downpayment, method, and any manual override decision; verification metadata is recorded against the payment.
3. `POST /api/bookings/reconcile-payment-state` requires an active admin actor. It recalculates verified paid amount, reconciles eligible booking status, and updates assignment notices.
4. The staff task API only returns active assigned bookings whose verified payment total meets the required downpayment. Booking status alone does not make a staff job visible.
5. If a booking has a staff ID and is payment-eligible, a `TASK_ASSIGNED` notification is created for that staff profile. On reassignment/payment ineligibility, stale notices are revoked/updated so an old recipient does not retain an actionable link.

### C. Staff service and customer-visible progress

1. Staff dashboard requests `/api/staff/tasks`; backend authenticates the staff actor, queries `bookings.staff_id`, returns the restricted vehicle/service projection, and filters payment/lifecycle states.
2. A staff notification or unit card opens a scoped booking/unit lookup, not a customer-wide booking query. A different staff member’s active assignment should resolve to 404/403 rather than expose vehicle details.
3. Staff records intake evidence, starts the service at the scheduled time/date while clocked in, updates unit notes/status, and records completion evidence. Backend and SQL guards validate assignment, state transitions, downpayment, and evidence.
4. Unit status changes can roll up to the booking master status. Customer booking subscriptions watch booking, units, and payment rows so a child-row change refreshes the customer projection.
5. Customer receives lifecycle/status updates and can view allowed evidence and the assigned technician’s display name; staff does not receive customer billing/chat access through the staff task projection.

### D. Completion, payment settlement, release, and refund

* Booking completion depends on the unit states and financial state; further payment/overpayment can create customer credit and/or ledger entries.
* Release, cancellation, no-show, restoration, and rescheduling use separate guarded server/RPC lifecycle paths. Terminal-state and capacity guards prevent invalid transitions/races.
* Admin refund screens join bookings to customer, units/services, payments, and queued refund credits. The system treats negative `SYSTEM_REFUND` payments as the canonical posted refund ledger entry, while queued/processing refunds are separate states.
* Customer billing and booking-detail screens use linked payment/refund rows and shared payment-summary calculations for balances; receipt surfaces use a separate invoice/per-transaction receipt model described below.
* Lifecycle email and official receipt delivery is idempotent via `booking_email_deliveries`; it is not intended to send duplicate receipts on retry.

## 5. Payment truth, parallel calculations, triggers, and receipts

This section distinguishes the *transaction record*, *OCR observation*, *booking-level summary*, and *presentation-specific totals*. They are related but are not interchangeable. Several consumers still calculate amounts independently, so identical payment rows can produce different displayed or operational totals.

### 5.1 Which record is authoritative for what?

| Question | Intended source | Important detail |
|---|---|---|
| What was the agreed booking price? | `bookings.total_amount`, with frozen service/promo snapshots | This is the booking amount due. Booking totals are not the same as paid amounts. |
| What did the receipt image appear to show? | Server OCR result, rich metadata on `bookings.ocr_metadata` (and payment OCR metadata) | The uploaded image bytes are parsed server-side. `payments.detected_amount` is the OCR-detected net amount; reference, gross, fee, recipient, duplicate/match details and audit metadata are also retained. This is evidence, not proof of settlement by itself. |
| What was submitted/recorded for a transaction? | A `payments` row, especially `amount`, `method`, `status`, receipt and reference fields | At submission, `amount` can be the declared/required amount, while `detected_amount` is the OCR finding. The admin verification flow may then overwrite `amount` with the human-verified amount. Interpret it with status and the OCR columns, not alone. |
| What does the shop recognize as received? | Settled payment rows plus negative refund rows, through `booking_net_paid` / `booking_financial_ledger` | The latest SQL rule uses positive `detected_amount` when available, otherwise `amount`; only settled statuses count; `SYSTEM_REFUND` negative rows are subtracted. The current rule does not add `transfer_fee` to shop receipts. |
| Is the booking ready for staff / operationally confirmed? | Payment eligibility plus booking lifecycle and current `staff_id` | Payment row state and booking `status` are separate. Staff access has its own verified-downpayment gate. |
| What is the coarse payment state stored on the booking? | `bookings.payment_status` enum | This has fewer states (`unpaid`, `pending`, `paid`, `refunded`) than `payments.status`. OCR maps `FOR_VERIFICATION` to booking `pending`; it cannot encode every transaction/rejection/refund detail. |
| What should an account screen show? | Varies today by page | Customer billing/detail and admin booking detail use shared frontend summary math; several list/dashboard/report/refund projections still use simpler direct sums. |

### 5.2 OCR → human verification → ledger path

1. The OCR endpoint parses the uploaded image and stores a server-issued `ocr_scan_id`. A valid-looking image still does not settle money: a customer payment enters payment status `FOR_VERIFICATION` and booking status `pending`. A rejected receipt is blocked by the secured atomic booking creation path. Manual review can preserve an unreadable receipt for human adjudication.
2. The secure `create_booking_atomic_secure` wrapper validates the scan session against the booking/payment payload, then derives the payment status and stores detected amount/reference, fee, net credit, OCR metadata, scan ID, and evaluated booking total. It does not trust a browser-created `FOR_VERIFICATION` state on its own.
3. On the main Admin Payments screen, verification determines the amount from positive `detected_amount` or falls back to the declared `amount`, checks downpayment requirements, and calls `admin_override_payment_to_paid`. That RPC validates admin identity, changes the payment to `PAID`, stores the chosen amount/verifier/time, and sets `manual_override`/`ocr_locked`. A delayed OCR persistence call is designed not to overwrite a settled/locked human decision.
4. The booking detail screen has a separate verification/force-confirm path that writes `payments` directly from the browser. It also updates amount/status/verifier and later reconciles, but does not call the same atomic override RPC or consistently set the same lock fields. Thus two administrator screens can perform the nominal action “verify payment” with different write/audit semantics.
5. Reconciliation calculates booking eligibility and operational status and creates or cleans up staff task notifications. It does not make the per-payment row, booking enum, customer-facing balance, and receipt document one single stored value; they are separate projections.

### 5.3 Independent money formulas that can diverge

The active system contains more than one “paid” calculation:

| Consumer | Current calculation / use | Divergence risk |
|---|---|---|
| SQL `booking_net_paid` and `booking_financial_ledger` (latest override: `20261021000011_net_received_financial_ledger.sql`) | For settled positive rows (`PAID`, `REFUND_PENDING`, `REFUNDED`), use `detected_amount` if positive, else `amount`; exclude `SYSTEM_REFUND` source rows; subtract negative refund rows once. Show `FOR_VERIFICATION` separately as pending, never settled revenue. Transfer fee is a separate reported field, excluded from recognized funds. | Closest thing to a canonical booking ledger, but not every UI or server path calls it. |
| Frontend `calculatePaymentSummary` | Intended mirror of SQL: detected net or fallback amount on settled positive rows, subtracts negative refunds, separately tracks balance/credit. Used by customer billing/details and admin booking detail. | Follows the net-received rule but duplicates it in JS, so it can drift when SQL changes. It uses `REFUND_PENDING` and `REFUNDED` positive rows as credit, while backend operational helpers below only count `PAID`. |
| Backend `calculateNetPaid` | Same broad settled-status and detected-net approach as the SQL ledger; excludes `SYSTEM_REFUND` credits and subtracts negative refunds. Used by add-service, booking confirmation/completion, and release checks. | A second backend implementation of the canonical-style formula; separate from `calculateVerifiedPaid` and still has independent maintenance/drift risk. |
| Backend `calculateVerifiedPaid` | Counts only `PAID` rows, sums `amount`, subtracts negative refund rows. Used by staff eligibility, payment reconciliation, service start and status propagation. | It does not consult `detected_amount`/`net_credit`; it assumes verification rewrote `amount` to the verified figure. It also excludes `REFUND_PENDING`/`REFUNDED` source credits that the canonical ledger includes. Legacy rows or alternate writers can therefore make operational gating differ from the SQL/customer ledger. |
| Admin Payments receipt-status text | Sums raw `amount` for `PAID` rows; uses `refund_status` to special-case processed refund. | Not the same as refund-aware net paid or detected-net math. |
| Admin Refunds | Sums raw positive `amount` for `PAID`, `REFUND_PENDING`, `REFUNDED`; subtracts negative `SYSTEM_REFUND` rows; separately reads queued credits. | Does not use `detected_amount` as the positive credit basis, so it may seed a different refundable amount than the SQL ledger for legacy/mismatched OCR rows. |
| Admin Dashboard revenue and refund queue count | Revenue is raw `amount` for rows with `status = PAID`; refund queue liability sums raw `amount` for `PAID`/`REFUND_PENDING`. | Revenue does not subtract refund rows or use OCR net; dashboard figure is not identical to net revenue/refund-hub balance. |
| Admin Sales Report | Selects positive `amount` rows with `PAID`/`REFUNDED`; separately sums negative `REFUNDED` rows for refunds; uses payment `created_at`. | Raw amounts rather than OCR net; status filters differ from dashboard/refund/customer formulas. In particular, a positive source row marked `REFUNDED` and a negative refund row are handled as separate rows. |
| Customer My Bookings summary | On that list, sums only `amount` of `PAID` payments and subtracts it from booking total. | Does not use the shared helper; ignores detected net, refunds, pending/overpayment credit. The detail/billing screens can consequently show a different result from the list card. |

Practical discrepancy example: if a digital source payment has `amount = 1,000`, `detected_amount = 970` (net received), and `transfer_fee = 30`, the latest SQL ledger and shared frontend helper recognize 970; the backend `calculateVerifiedPaid` recognizes 1,000 if it reads that row without the expected rewrite; and the customer transaction receipt resolver can show gross paid 1,000 and net received 970. The email lifecycle amount resolver additionally counts transfer fee toward booking credit. Those values answer different questions but several screens label them generically as “paid,” “balance,” or “received,” making them look contradictory.

### 5.4 Trigger side effects and duplicate action paths

Payment writes have several distinct automatic side effects:

* `payments_reconcile_booking_credit` runs after payment insert/update/delete and recalculates booking excess credit. `bookings_reconcile_booking_credit` does so after relevant booking total/customer changes. These triggers maintain `customer_credit_ledger`; they are not the same as changing payment status or emailing a receipt.
* `payments_allocate_refund` runs after insertion of a negative `SYSTEM_REFUND` row and allocates it to source payment rows in `payment_refund_allocations`. The refund row is the signed transaction; the allocation table explains which source rows it consumes.
* `trg_audit_payment_change` records payment submission, verification, rejection, and refund state changes in `audit_logs`.
* Admin verification can also write explicit audit rows. The main Admin Payments RPC records manual override itself; its fallback explicitly writes an audit record. The separate Booking Details force-confirm path writes an explicit manual-override audit row while its ordinary payment update can also be seen by the payment audit trigger as a `PAYMENT_VERIFIED` event. This produces overlapping audit events with different labels for a single human action.
* Booking confirmation/status email has multiple invokers: client booking creation/verification flow, backend lifecycle/status handlers, and a retained database status-trigger path that calls the retired status-email entry point (which redirects to `booking-lifecycle`). `booking_email_deliveries` claims by booking/event and suppresses duplicate canonical emails, so multiple invocations should not send multiple copies of the same event. It does not unify their reason, timing, or all unrelated notification side effects.
* Payment and booking-level statuses are not one trigger-maintained state machine. OCR persistence updates `bookings.payment_status`; the admin override RPC updates `payments.status` but not that booking enum. Backend reconciliation updates booking lifecycle status (`bookings.status`) and staff task alerts. Screens must not assume one field mirrors the others automatically.

### 5.5 Receipt/invoice surfaces and email paths

“Receipt” currently refers to several different documents/data views:

| Surface | Builder / input | What it represents |
|---|---|---|
| Customer booking receipt route `/customer/receipt/:id` | Frontend `OfficialReceipt` with `selectedPayment = null`; uses booking total, discount snapshot, and service price snapshots. | A booking-level invoice/amount-due document, not a per-payment receipt. It can show the full booking total even when the customer has paid only a downpayment. |
| Transaction receipt modal in customer/admin UI | Frontend `OfficialReceipt` with one `selectedPayment`, using shared `receiptModel.ts`. | One transaction. Displays gross paid, transfer fee, net received and credit-applied; receipt number is `RCP-<payment UUID>`. The renderer itself does not enforce settled status; callers must gate access. |
| Booking lifecycle confirmation/status email attachment | Supabase `booking-lifecycle` calls shared `officialReceiptPdf.ts`, which uses the shared per-transaction receipt model. It attaches one newest `PAID` payment when `resolveAmounts` says the booking is fully settled. | A server-generated PDF, separate implementation from the browser HTML/PDF receipt. For multiple installments, the attached PDF is based on the selected newest verified transaction, not an aggregate statement of every payment. |
| Legacy backend `/api/emails/payment-receipt` | `backend/services/transactionAmounts.js` plus backend email HTML/PDF builders; can also attach the uploaded receipt image. | A second server-side receipt builder with its own amount resolver, formatting and transport. It explicitly logs an OCR-vs-recorded discrepancy, but is not the same renderer as the lifecycle Edge Function. |
| Legacy `/api/emails/booking-confirmation` and `/send-email` | Backend templates/legacy handlers. | Additional confirmation/payment email entry points remain in the source. They should not be treated as equivalent to the idempotent lifecycle receipt without verifying callers. |

Important inconsistencies:

1. `shared/receiptModel.ts` and the browser receipt renderer calculate a transaction’s **net received** as detected amount, else net credit, else declared amount minus fee; **gross paid** is detected amount plus fee when OCR exists, else declared amount. This is intentionally a per-transaction presentation.
2. `supabase/functions/_shared/bookingEmail.ts::resolveAmounts` calculates remaining balance using `netReceived + creditApplied + transferFee`. That credits the transfer fee toward the booking, while current `booking_net_paid`/`booking_financial_ledger` explicitly exclude that fee from shop-recognized funds. Its submitted-email totals include `FOR_VERIFICATION`; its verified totals include only `PAID`.
3. The lifecycle function’s full-settlement test uses that email resolver, then generates a PDF for only the newest `PAID` row. The PDF says “This receipt records one payment transaction.” A booking can therefore qualify as “settled” using a formula that differs from the SQL ledger and still receive a single-transaction receipt rather than a cumulative paid-to-date receipt.
4. The booking-level browser invoice and one-payment transaction receipt are different intended documents, but both are reached through receipt-related UI. If the user expects a cumulative official receipt, neither the transaction PDF nor the booking invoice alone supplies that exact view.
5. `booking_email_deliveries` is unique per booking/event, not per payment. `booking_confirmed` is sent only when that lifecycle event is invoked and claimed; the current reconciliation endpoint invokes it when the booking status changes to confirmed. If another verified payment later settles the balance while the booking remains confirmed, that reconciliation does not change booking status and therefore does not itself dispatch a second confirmation email/receipt. A later lifecycle status email can attach a receipt if its settlement check passes.

### 5.6 Main payment consistency gaps to keep in view

* Prefer the database financial ledger or one shared typed calculation for all booking/account projections; the dashboard, sales report, refund hub, customer booking list, and backend operational gate currently have independently authored sums.
* Make both Admin Payments and Admin Booking Details call one admin verification RPC, so amount selection, OCR lock, status transition, and audit semantics do not depend on which screen performed verification.
* Clarify the amount contract: `amount` (declared/verified transaction amount), `detected_amount` (OCR net received), `transfer_fee`, `net_credit`, `credit_applied`, and `signed_amount` should each have one documented meaning and not be interchanged. In particular, reconcile whether transfer fees count toward customer booking settlement or only gross customer outlay; SQL ledger and lifecycle email currently answer this differently.
* Decide whether the emailed official receipt is transaction-level or cumulative. If cumulative, it must include all settled source rows and refunds/credits from the canonical ledger, not merely the latest PAID row.
* Retire or explicitly route legacy receipt/confirmation endpoints through `booking-lifecycle`, and test that retries, full-balance settlement after a downpayment, admin walk-ins, cash, partial refund, and overpayment have identical account totals and receipt values.

## 6. Notification, email, and chat routing

### In-app notifications

`notifications` rows have a recipient `user_id`, type/title/message, optional `booking_id`/entity, action URL, timestamps, and read state. Recipients fetch only their own notification rows through client filters and RLS; staff and customer layouts maintain unread counts and subscribe for updates. Admin notification management can broadcast or manage notifications through admin routes/backend functions.

Notification action URLs must be role-aware. Customer booking links are under `/customer`; staff task links should resolve to `/staff/tasks` or the specific assigned unit route; admin links resolve to `/admin`. Contextual notifications such as chat/status may be suppressed unless they include a valid booking context.

The staff assignment notice is an alert, not an authorization grant. The live `bookings.staff_id` relation is authoritative. For a released booking, the staff endpoint allows a read-only historic vehicle projection only if the authenticated staff member owns a `TASK_ASSIGNED` notice for that booking. This exception does not grant active update rights. Stale notices are revoked when a former assignee attempts access or payment/assignment state is reconciled.

### Email

Booking lifecycle emails are dispatched through the `booking-lifecycle` Supabase function and backend email service, with a database delivery guard. Payment confirmation may attach an official receipt. Other separate flows cover invitation, account recovery, QR/email changes, and notification emails. Email payload/event selection is centralized to keep the portal and receipt totals consistent.

### Chat

The customer owns one persistent thread keyed by customer ID, regardless of number of bookings. A message may keep the currently selected booking ID to explain context. Admin/customer are the supported chat roles; current SQL migrations explicitly restrict chat from staff. Unread counts are keyed by customer thread and realtime events refresh the global/per-thread badges. Legacy messages may resolve missing `customer_id` through their booking.

## 7. Backend/API and database enforcement map

### Backend route families

`backend/server.js` contains these main route families:

* Authentication/account: invite validation/acceptance, customer registration, password verification/change/recovery, email change, QR OTP, deactivation.
* Admin/account operations: profile directory, invite-account, access revocation, service usage, broadcast, catalog announcement, promos, purge and audit/debug endpoints.
* OCR/email: receipt verification, booking confirmation/receipt email, lifecycle communications.
* Booking lifecycle: cancel/admin-cancel, undo no-show, add service, master/unit status, release, payment-state reconcile, slot validation/listing, financial ledger and receipt.
* Staff: tasks, shift toggle, preferences.
* Scheduling/admin configuration: blocked-slot mutations and schedule validation.
* Garage: garage sync and promo reads.

Sensitive APIs use a verified Auth bearer token plus server-side profile role checks and/or a guarded SQL RPC. The backend’s Supabase service-role client bypasses ordinary RLS, so every service-role handler must perform its own authorization and ownership checks.

### Database policies and lifecycle functions

The migration set is the effective implementation of schema and policy. Relevant groups include:

* Atomic booking creation, identity normalization, capacity/slot locks, reschedule and operating-hour constraints.
* Profile role-escalation and admin lifecycle protection, invite/account creation, first-login password flags, staged login lockout and recovery OTP.
* Payment/OCR-verdict constraints, financial ledger functions, authorized credit/refund writes, refund allocations, and booking/payment reconciliation.
* Service catalog prerequisite and frozen-price/snapshot protections.
* Staff assignment, start/stop, no-show restoration, terminal-state lock and verified-downpayment gates.
* Scoped photo metadata/storage policies, private object bucket, evidence gates, and retention.
* Customer/admin participant chat policies and staff chat restrictions.
* Audit trail, booking creator tracking, idempotent email delivery, and notification controls.

RLS is table-specific. For example, the photo policies explicitly join through the booking to resolve customer ownership or current staff assignment and require verified downpayment for staff. Do not infer that every table has equally restrictive policies merely because one table’s policy is strong.

## 8. Authorization and data-visibility summary

| Data/action | Customer | Assigned staff | Admin |
|---|---|---|---|
| Own profile/account | Own profile/settings; account recovery/deactivation flows | Own profile/preferences/duty state | Own profile plus broader account administration |
| Booking master | Own linked bookings; guest/nonlinked bookings are not automatically customer-visible | Not returned in full by staff task API; selected operational fields only, scoped to `staff_id` | Broad operational access |
| Vehicle unit/services | Own booking units and own garage vehicles | Only units in currently eligible assigned bookings; read projection contains technical/vehicle information | Broad operational access |
| Customer identity/contact | Own information | Not part of the intended staff task projection | Linked customer profile/contact as needed for operations |
| Payments/receipt | Own payment history and receipts | Eligibility is checked server-side; payment data is not exposed in the task response | Verify, audit, refund, and reconcile |
| Service evidence | Own booking evidence subject to policy | Current assigned booking and verified-downpayment/evidence rules | Read/manage/audit |
| Chat | Customer-owned thread | Not eligible in current chat feature/policies | Customer conversations and contextual booking tags |
| Assignment | Can view technician display name through restricted lookup | Can view only own current assignment; historic released detail has narrow notification-based read exception | Assign/reassign and audit |

## 9. Observed caveats and reconciliation points

These are source-level observations that matter when operating or extending the system:

1. **A notification is not assignment truth.** It is persisted separately from `bookings.staff_id`; old alerts can outlive reassignment. The current task endpoint rechecks the live assignment and includes explicit stale-notice cleanup. Any new notification deep link must keep this server-side check.
2. **One legacy booking resolver still has schema drift.** `frontend/src/utils/notificationRouting.js` falls back to querying `bookings.booking_id` for a non-UUID reference, while the deployed schema inspection during the staff incident found no such column. UUID and UUID-prefix paths resolve before that fallback, and staff job routing uses `/api/staff/tasks`; however, the generic fallback can still fail for other reference formats. Keep notification booking references as actual `bookings.id` UUIDs or repair that resolver before relying on alternate references.
3. **Direct Supabase frontend access is common.** Many page reads use the browser Supabase client and depend on RLS. The backend service-role path is not automatically safer: it bypasses RLS and must enforce the caller’s role and ownership in each handler.
4. **Some legacy staff relay endpoints need a consistent auth review.** The inspected `/api/staff/toggle-shift` and `/api/staff/update-preferences` handlers accept a `userId` from the request body and update that profile without invoking `getLifecycleActor` in the handler. The frontend sends the current profile ID, but client behavior is not an authorization control. Confirm whether upstream middleware exists (none is apparent from the server setup inspected) and harden those routes to derive the actor from a verified JWT.
5. **Notification URLs are not an access policy.** Route guards keep the wrong role out of the corresponding UI, but every deep-link destination must still fetch data through ownership/assignment-aware RLS or a backend check.
6. **Schema migrations have had real deployment drift.** The staff incident exposed assumptions about nonexistent `booking_vehicles.is_fleet` and `bookings.booking_id`; the implementation was corrected to use actual fleet-group and booking UUID fields. Future query changes should be checked against applied migrations/schema, not only frontend query strings.
7. **Some user-facing projections are assembled from multiple reads.** Customer booking details manually fetch booking, vehicle units, service lines, and payments; admin detail separately fetches profiles and audit entries. Errors and missing child rows may therefore appear as partial UI state unless each read is handled and surfaced.
8. **Role status can change independently of a live JWT.** The backend actor helper checks profile activity/role on privileged lifecycle requests. Long-lived frontend state also needs refresh/revocation handling; role and active-state policies/triggers are present in migrations for account lifecycle protection.

## 10. Operational trace checklist

When diagnosing a missing or incorrect cross-tier view, verify in this order:

1. Auth user UUID maps to the expected `profiles.id`, expected role, and active profile.
2. Booking uses `bookings.id` as the reference; customer linkage is the expected `customer_id` (or guest contact fields).
3. The expected worker is exactly `bookings.staff_id`; a task notification alone is insufficient.
4. Booking status is nonterminal for active work and payment rows meet the verified downpayment rule.
5. Each `booking_vehicles` row has the right `booking_id`, vehicle-unit status, and linked `booking_vehicle_services`.
6. Relevant RLS/RPC/backend checks match the intended actor; inspect whether a query is using the browser client or service-role client.
7. For photos, check both `service_photos` metadata and the private bucket object path/policy.
8. For a deep link, inspect notification `user_id`, `booking_id`, type, and action URL, then confirm that its destination resolves the booking through the authenticated role-specific path.
9. For payment/refund display, inspect transaction statuses, positive payment rows, negative `SYSTEM_REFUND` rows, credit-ledger entries, and refund allocations together.
10. Confirm the deployed database has applied the migration that defines each field, policy, trigger, or RPC referenced by the code.

## Source map

* Frontend role route tree and providers: [main.jsx](../frontend/src/main.jsx)
* Session/profile/role loading: [AuthContext.jsx](../frontend/src/context/AuthContext.jsx), [ProtectedRoute.jsx](../frontend/src/components/ProtectedRoute.jsx)
* Customer shared data subscriptions: [UnifiedContext.jsx](../frontend/src/context/UnifiedContext.jsx)
* Chat thread model: [ChatContext.jsx](../frontend/src/context/ChatContext.jsx)
* Booking creation, snapshots, and payment initialization: [bookingService.js](../frontend/src/services/bookingService.js)
* Admin booking directory data layer: [useAdminBookings.js](../frontend/src/hooks/useAdminBookings.js)
* Admin booking/payment/refund flows: [AdminBookingDetails.jsx](../frontend/src/pages/Admin/AdminBookingDetails.jsx), [AdminPayments.jsx](../frontend/src/pages/Admin/AdminPayments.jsx), [AdminRefunds.jsx](../frontend/src/pages/Admin/AdminRefunds.jsx)
* Frontend booking payment math: [paymentUtils.js](../frontend/src/utils/paymentUtils.js)
* Browser invoice and transaction receipt: [OfficialReceipt.jsx](../frontend/src/components/OfficialReceipt.jsx), [receiptModel.ts](../shared/receiptModel.ts)
* Server OCR and amount resolver: [server.js](../backend/server.js), [transactionAmounts.js](../backend/services/transactionAmounts.js)
* Lifecycle email amount resolver and receipt PDF: [bookingEmail.ts](../supabase/functions/_shared/bookingEmail.ts), [officialReceiptPdf.ts](../supabase/functions/_shared/officialReceiptPdf.ts)
* Canonical financial ledger and payment/refund triggers: [20261021000011_net_received_financial_ledger.sql](../supabase/migrations/20261021000011_net_received_financial_ledger.sql), [20261021000010_booking_scoped_verified_credit.sql](../supabase/migrations/20261021000010_booking_scoped_verified_credit.sql), [20261023000004_payment_refund_allocations.sql](../supabase/migrations/20261023000004_payment_refund_allocations.sql), [20261023000005_audit_payment_and_staff_changes.sql](../supabase/migrations/20261023000005_audit_payment_and_staff_changes.sql)
* Atomic booking/OCR scan-session validation: [20261021000009_server_ocr_scan_sessions.sql](../supabase/migrations/20261021000009_server_ocr_scan_sessions.sql)
* Staff task authorization/data projection: [server.js](../backend/server.js) (`GET /api/staff/tasks`)
* Staff unit view and scoped client lookup: [StaffJobDetails.jsx](../frontend/src/pages/Staff/StaffJobDetails.jsx), [notificationRouting.js](../frontend/src/utils/notificationRouting.js)
* Photo metadata and signed URL service: [photoService.js](../frontend/src/services/photoService.js)
* Core backend actor helpers and API handlers: [server.js](../backend/server.js)
* Schema, RLS, RPCs, and triggers: [migrations/](../supabase/migrations)
