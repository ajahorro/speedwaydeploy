# Booking Submit — Defect Report & Fixes

Written after reproducing every failure against the live database.
**Current state: booking submit works end to end. 83/83 tests pass.**

---

## 1. Root cause of "I can't book" — nothing to do with the frontend

`npx supabase migration list` showed **13 migrations in the repo that had never
been pushed** (every version from `20261017000001` onward, Remote column empty).

Four of them (`20261016000001`–`4`) exist *specifically* to cast
`payment_status` to its enum. They were written, committed, and never applied —
which is why editing frontend code hundreds of times changed nothing.

```
42804: column "payment_status" is of type booking_payment_status
       but expression is of type text
```

### Why four "fix" migrations silently did nothing

`create_booking_atomic` is patched by a runtime `replace()` on the function
source. When the anchor text does not match, the patch takes its `raise notice`
branch — **the migration still commits, and the ledger still records it as
applied.** The database keeps the old body. There was also no way to read a
function body through PostgREST, so nobody could see it.

Fixed by adding `debug_function_source()`, and by making the patch migrations
`raise exception` on an unmatched anchor so they cannot record success without
acting.

### Two bugs in the migrations themselves

| Bug | Effect |
|---|---|
| `''''` used for an empty-string literal in generated SQL | Postgres read it as an empty literal and dumped raw SQL at top level → `syntax error at or near "to_jsonb"` |
| `coalesce(text, uuid-function)` | `COALESCE types text and uuid cannot be matched` — crashed **every** booking |

The second was **masked by the first**: the enum crash blocked the insert one
line earlier, so nobody saw the type error behind it.

---

## 2. CRITICAL — silent data loss on every booking

This is the worst defect found, and it was destroying real customer data.

```
total_amount = 0, customer_name = null, start_datetime = null, status = null
```

The row was created and had an id, so submit reported **success** and emailed the
customer — but the booking carried no money, no customer and no time.

**Cause.** The SC-1 identity patch ran:

```sql
v_booking := jsonb_set(v_booking, '{customer_id}',
                       to_jsonb(public.resolve_customer_by_email(...)),  -- NULL
                       true);
```

`to_jsonb(NULL)` is the JSON scalar `null`, and
`jsonb_set(target, path, null, create_if_missing => true)` on a JSON `null`
**discards the entire target object**. Every following read is
`(null) ->> 'total_amount'` → NULL.

A guest booking's email usually has no matching profile, so this fired on almost
every customer self-service booking — the common path, not an edge case. The
`exception` handler swallowed the resulting `create_validate` error and returned
the function default, so the caller saw success.

**Evidence in your production data:** 5 of 10 bookings have
`total_amount = 0`, `customer_name = null`, `start_datetime = null`.

> **Correction (measured, not assumed).** The payload-wipe mechanism above is
> confirmed: the defect is real, the fix is real, and a booking now persists
> `total_amount = 250` where it previously persisted `0`.
>
> What the `jsonb_set` reasoning does NOT establish is **how many of those 5
> rows were caused by this specific bug**. The most recent corrupted booking was
> created at `2026-09-25 09:50 UTC`, before the SC-1 repair landed at ~10:36 UTC
> — but I did not inspect those 5 rows individually, and some may predate the
> SC-1 patch entirely (an all-NULL row is also what a much older, unrelated
> defect would leave behind). The count is real; the attribution is not proven.
> Worth a look before you decide what to do with them.

**Fix.** Resolve the id into a variable and assign it only when non-null; leave
the payload untouched otherwise. Plus an `APEX_PAYLOAD_INTEGRITY` assertion
inside the function so a degraded payload raises instead of being persisted.

---

## 3. Emails — one per event, correct amounts, real OCR data

### 3.1 The flood

One booking dispatched **two** emails: a "Payment Submitted" notification email
(client event engine) *and* a "Booking is now SCHEDULED" lifecycle email
(`send-status-email`). Neither was guarded, so any retry sent again.

### 3.2 The amount mismatch

The receipt email took `payment.amount || booking.total_amount` and then **added
12% VAT on top** — in a shop whose published prices already include VAT. A
customer who paid ₱250 for a ₱250 booking was emailed a "Total Amount Due" of
₱280. The lifecycle email independently quoted `booking.total_amount`, so the
two emails disagreed with each other for the same payment.

### 3.3 The OCR was never read

`persist_ocr_result()` writes the rich OCR metadata to **`bookings.ocr_metadata`**
(not `payments`), and the payment row carries only `detected_amount` /
`detected_ref`. The emails read **none** of it — no reference number, no sender,
no transaction date.

### The adopted lifecycle (industry standard)

A receipt is a financial document. It must only be issued against **verified**
money, so it cannot ride on the submission email where the payment may still be
rejected.

| Event | Email | Receipt? |
|---|---|---|
| `booking_created` | Booking summary + payment as submitted + **what OCR read** (reference, sender, date, detected amount), explicitly marked *not yet verified* | No |
| `booking_confirmed` | Confirmation + **official receipt PDF attached** | **Yes** |
| any other status | Plain status update | No |

Exactly-once is a **database invariant**, not a convention: every send claims a
row in `booking_email_deliveries` keyed `(booking_id, event)`. A duplicate is
refused by the primary key, so a retry, a double-tap or two concurrent callers
cannot double-send. A *failed* send releases its claim (so a transient provider
error is still retryable), while a *delivered* one can never be released.

### Money model (one implementation, three consumers)

`gross` = what the customer sent · `net` = what the shop received ·
`due` = what the booking costs.

- The **transfer fee is not a shortfall** — the customer paid it, the bank kept
  it in transit. Crediting the gross stops a cross-bank transfer reading as
  short-paid.
- **VAT is broken out of** a VAT-inclusive total, never added to it.
- `ocr` vs recorded divergence is **detected and audited**
  (`OCR_AMOUNT_MISMATCH`) rather than silently papered over.

---

## 4. Excess-credit write was impossible (RLS 403)

```
403 42501: new row violates row-level security policy
           for table "customer_credit_ledger"
```

The browser inserted directly into the ledger, whose only write policy requires
admin — a paying customer is not an admin. Every legitimate overpayment was
rejected, and because the caller passes `sendFailure: false` it did not even
surface. A second defect hid behind it: the client computed `balance_after` from
a `sum()` of *all* prior entries, so concurrent bookings lost updates.

Fixed with an authorized, serialized, **idempotent** `record_excess_credit()`
RPC. Verified live as a real customer: the direct insert is still correctly
blocked, the RPC succeeds, and a cross-customer write is refused.

---

## 5. Bookings could not be deleted

```
violates foreign key constraint
"booking_vehicle_services_booking_vehicle_id_fkey"
```

`booking_vehicles.booking_id` cascades from `bookings`, but
`booking_vehicle_services.booking_vehicle_id` did **not** cascade from
`booking_vehicles`. The chain broke in the middle, so any purge, retention job
or abandoned-cart cleanup failed with a raw constraint error. Fixed the cascade
and added an admin-only `delete_booking_cascade()`.

---

## 6. Regression guards added

| Command | Guards against |
|---|---|
| `npm run test` | Unit suite — 68 tests incl. the money model and exactly-once semantics |
| `npm run test:source` | Structural checks on the email modules (types present, VAT formula, service-role guard) |
| `npm run test:live` | **Functional** check: submits a real booking and asserts it *succeeds*. Presence checks all passed while every submit was failing — that is how this hid. |
| `npm run test:emails` | Lifecycle: one email per event, duplicates refused (incl. 3 concurrent), receipt only on confirmation, OCR fields present in the rendered HTML |

### VAT rate correction

`vatIncluded` divided by `112` (treating 12% as 12/112 = 10.71%) in the shared
email module and the backend amount model. On a ₱250 total that produced
**₱26.79 VAT / ₱223.21 base**. The correct split is **₱30.00 VAT / ₱220.00 base**
(base = gross / 1.12). The unit test had been locking in the wrapper's own
rounding (`₱26.79`) rather than an independently derived figure, so it could not
catch this — it now asserts `base + vat === total` and the correct base, which a
rate error cannot survive.

`verify-booking-prereqs.mjs` was verified to flag the pre-fix body as failing.

---

## Unresolved / needs your judgement

1. **5 corrupted bookings remain.** They have no customer, total or schedule, so
   they cannot be repaired — only deleted. I did **not** delete them; that is
   your call. `delete_booking_cascade(id)` is available.
2. **The vehicle-picker cards are unclickable** at a 758px viewport — a
   full-width header slats over them until you scroll. Unrelated to this work,
   but check it before deployment.
3. **`send-status-email` is now a redirect shim** into `booking-lifecycle`. Safe
   to delete once no caller references it.
4. **The backend was down** during the original report (`ERR_CONNECTION_REFUSED`
   on `:3000`). The client fails *soft* on an unreachable validator and proceeds
   without a pre-check. Confirm the backend runs in your deploy.
5. **13 migrations sat unapplied for hours.** The new guard only helps if
   something actually runs it — the deploy step that should push migrations
   appears not to.