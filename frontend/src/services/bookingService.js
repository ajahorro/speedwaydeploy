import { supabase } from '../lib/supabase';
import { subscribeTable } from '../lib/realtimeHub';
// NOTE: this module must not import eventEngine/notificationService at the top
// level. eventEngine imports notificationService, and both are pulled back in by
// this module's consumers, which closes a cycle that evaluates one of them in the
// TDZ and throws `Cannot access '<symbol>' before initialization` at render time.
// `emitEvent`/`EVENTS` used to be imported here and were never referenced — a
// dead import that silently shipped the cycle. Emit booking events from the
// caller (see AdminWalkInWizard / CustomerBookAppointment) or via
// emitEventToMany, which reach eventEngine through an acyclic path.
import { SHOP_CONFIG } from '../config/constants';
import { getEffectivePriceForService, calculateBookingDiscountSummary, buildBookingServiceSnapshot, validateServiceRequirements, describeServiceRequirementViolation } from '../data/servicesCatalog';
import { getRequiredDownpayment } from '../utils/paymentUtils';
import { buildLocalDateTime, formatLocalISODate } from '../utils/dateTimeUtils';
import { sendStatusEmail } from './notificationService';
import { calculateBayUsage } from '../utils/schedulingUtils';
import { BACKEND_URL } from '../config/api';
import { fetchBookingLedgers } from './ledgerService';
import { getBayCapacity } from '../config/shopConfig';

const normalizeServiceId = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : null;
};

/**
 * bookingService.js
 * Centralized booking logic for the Customer portal.
 * Handles creation, fetching, and real-time subscription for bookings.
 */

/**
 * Create a new booking with vehicles and services.
 * Mirrors the schema used by AdminBookings:
 *   bookings -> booking_vehicles -> booking_vehicle_services
 */
export const createBooking = async (customerId, bookingData) => {
  let bookingCustomerId = Object.prototype.hasOwnProperty.call(bookingData || {}, 'customerId')
    ? (bookingData.customerId ?? null)
    : (customerId ?? null);
  const isAdminWalkIn = Boolean(bookingData.adminWalkIn || bookingData.adminMode);

  // If this is an admin walk-in, ensure the admin's own user ID never becomes the customer_id
  if (isAdminWalkIn && bookingCustomerId && bookingCustomerId === bookingData.adminActorId) {
    bookingCustomerId = null;
  }
  const vehicles = bookingData.vehicles || [];

  // 🛡️ SCENARIO 1 — GUEST-TO-CUSTOMER IDENTITY COLLISION (last-line safety net).
  //
  // An admin can create a walk-in guest booking while typing an email that
  // secretly belongs to an existing VIP customer. The AdminWalkInWizard UI
  // already detects and offers to link the account, but that is a best-effort
  // CLIENT prompt: a dismissed prompt, an un-resolved debounce, an impatient
  // admin, or any OTHER caller of createBooking() could still submit with
  // customer_id = null and a real registered email.
  //
  // The result was an orphaned booking: no account link, so it is invisible in
  // the customer's portal, cannot be chatted on, and — because
  // bookings.customer_id stayed NULL — a later admin re-invite of the same
  // email could collide with the unique profiles.email constraint (the
  // "duplicate constraint crash" this scenario describes).
  //
  // We resolve the identity ONCE, here, at the single write boundary, using a
  // case-insensitive match, so every caller converges on the same account. An
  // explicit customerId always wins (the admin/UI decision is authoritative).
  if (!bookingCustomerId && bookingData.customerEmail) {
    const normalizedEmail = String(bookingData.customerEmail).trim().toLowerCase();
    if (normalizedEmail.includes('@')) {
      const { data: matchedProfile } = await supabase
        .from('profiles')
        .select('id')
        .eq('role', 'CUSTOMER')
        .ilike('email', normalizedEmail)
        .maybeSingle();
      if (matchedProfile?.id) {
        bookingCustomerId = matchedProfile.id;
        console.info('[Booking] Guest email matched an existing customer account — linking booking instead of orphaning it.');
      }
    }
  }

  const { data: customerProfile } = bookingCustomerId
    ? await supabase.from('profiles').select('email').eq('id', bookingCustomerId).maybeSingle()
    : { data: null };

  // 🛡️ SC-22 — PREREQUISITE INTEGRITY SHIELD.
  //
  // A add-on like "Waxx Add-on" declares `requires: [wash...]`. A stale tab or a
  // crafted payload could remove the wash while keeping the add-on, and nothing
  // used to stop it — the booking was accepted. We validate the dependency at
  // THIS write boundary (mirrors the client check in Step 4) so an isolated
  // dependent service is rejected with a clean, human message rather than
  // silently accepted or surfaced as a raw SQL error downstream.
  const requirementCheck = validateServiceRequirements(vehicles);
  if (!requirementCheck.ok) {
    throw new Error(describeServiceRequirementViolation(requirementCheck.violations)
      || 'A selected service is missing its required prerequisite.');
  }

  // 🛡️ INTEGRITY SHIELD: Prevent 'Ghost Bookings' (REQ-SYS-01)
  if (vehicles.length === 0) {
    console.error('CRITICAL: Attempted to create a booking without any vehicles.');
    throw new Error('SYSTEM ERROR: No vehicles provided for this booking session. Operation aborted for integrity.');
  }

  const maxBays = await getBayCapacity();
  const requestedBays = calculateBayUsage(vehicles);
  if (requestedBays > maxBays) {
    throw new Error(`This booking needs ${requestedBays} bays, but the shop currently has ${maxBays}. Two motorcycles can share one bay; cars and vans need a full bay.`);
  }

  // Pricing must mirror the wizard exactly: standard promos discount per line
  // item, while a unit bound to a package (vehicle.packageId) is charged the
  // fixed package rate instead of the itemised standalone sum. Reusing the
  // shared summary guarantees the persisted total cannot drift from the
  // amount the customer reviewed in Step 4.
  //
  // Section 4: promo eligibility is evaluated against the booking CREATION DATE
  // (this submit moment), not a later system time, so the persisted total
  // reflects the rule set in force when the booking was actually created.
  const pricingSummary = calculateBookingDiscountSummary(vehicles, new Date().toISOString());
  const totalAmount = pricingSummary.discountedTotal;
  const packagePlan = (pricingSummary.appliedPackages || []).map((entry) => ({
    package_id: entry.packageId,
    name: entry.name,
    package_price: entry.packagePrice,
    standalone_sum: entry.standaloneSum,
    savings: entry.savings,
  }));

  // Promo/discount snapshot for the ledger + official receipt. Previously these
  // columns were never written, so a receipt could not show the promo line and
  // analytics could not attribute savings. We freeze the figures the customer
  // actually reviewed so they can never drift after the promo window closes.
  const discountAmountSnapshot = Math.max(0, Number(pricingSummary.totalDiscount || 0));
  const appliedPackages = pricingSummary.appliedPackages || [];

  // A promo id can be EITHER a real database row id (a UUID) OR a package/rule id
  // synthesised in the browser (`promo-<timestamp>`) for a package that has no DB
  // row. `bookings.applied_promo_id` is a uuid column, so sending the synthetic
  // form aborted the ENTIRE booking with 22P02
  // (invalid input syntax for type uuid: "promo-1790542417063"). Only forward a
  // value that is genuinely a UUID; the promo NAME and DISCOUNT snapshots are what
  // the receipt and analytics actually display, and they are always sent.
  const asUuidOrNull = (value) => {
    const v = typeof value === 'string' ? value.trim() : '';
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
  };

  const appliedPromoId = asUuidOrNull(
    appliedPackages.length
      ? appliedPackages[0].packageId
      : (() => {
          // For standard promos, find the first promo applied on any service line.
          for (const vehicle of (vehicles || [])) {
            for (const service of (vehicle.services || [])) {
              if (service?.applied_promo) return service.applied_promo;
            }
          }
          return null;
        })()
  );
  const promoNameSnapshot = appliedPackages.length
    ? appliedPackages.map((p) => p.name).join(', ')
    : (() => {
        for (const vehicle of (vehicles || [])) {
          for (const service of (vehicle.services || [])) {
            if (service?.applied_promo) return service.applied_promo;
          }
        }
        return null;
      })();

  // Admin-created walk-in bookings are captured on-site with payment already
  // taken by the admin, so they skip the manual payment-verification pipeline
  // and are scheduled immediately as CONFIRMED. Customer self-service bookings
  // still start as 'scheduled' and await verification.
  const initialBookingStatus = isAdminWalkIn ? 'confirmed' : 'scheduled';

  // Task B: freeze the QR recipient target onto the booking at creation, so the
  // payment QR the customer sees can never be switched out from under them.
  const qrSnapshot = bookingData.qrSnapshot || null;

  // Build the immutable per-vehicle service snapshots once — they are reused
  // both on the booking row (service_snapshot) and on each service line.
  const bookingServiceSnapshot = (vehicles || []).flatMap((vehicle) => (vehicle.services || []).map((service) => {
    const snapshot = buildBookingServiceSnapshot(service, vehicle.type, 'booking');
    return {
      service_id: snapshot.service_id,
      service_name: snapshot.service_name,
      final_price: Number(snapshot.final_price || 0),
      duration_minutes: Number(snapshot.duration_minutes || 0),
      vehicle_type: snapshot.vehicle_type,
      service_snapshot: snapshot.service_snapshot
    };
  }));

  // Map the wizard payload into the shape expected by create_booking_atomic().
  const rpcVehicles = (vehicles || []).map((vehicle) => ({
    vehicle: {
      vehicle_type: vehicle.type,
      brand: vehicle.brand,
      model: vehicle.model,
      plate_number: vehicle.plateNumber,
      fleet_group_id: vehicle.fleetGroupId || bookingData.fleetGroupId || null,
      status: isAdminWalkIn ? 'CONFIRMED' : 'SCHEDULED'
    },
    services: (vehicle.services || []).map((service) => {
      const snapshot = buildBookingServiceSnapshot(service, vehicle.type, 'booking');
      return {
        service_name: snapshot.service_name,
        price: snapshot.final_price,
        final_price: snapshot.final_price,
        duration_minutes: snapshot.duration_minutes,
        vehicle_type: snapshot.vehicle_type,
        // Catalog IDs such as `moto_2` are application identifiers, not UUIDs.
        // Keep them in the immutable snapshot, but never send them to the UUID
        // column used by booking_vehicle_services.
        service_id: normalizeServiceId(snapshot.service_id),
        service_snapshot: snapshot.service_snapshot,
        // Keep the live pricing policy as the fallback path for older schemas.
        base_price: Number(service.original_price || service.price || 0),
        price_at_booking: snapshot.final_price
      };
    })
  }));

  // Payment payload mirrors the previous post-creation insert logic exactly.
  let rpcPayment = null;

  // ── The OCR verdict that gates booking creation ───────────────────────────
  // Derived from the scan result the customer's upload produced. This is the
  // value create_booking_atomic allow-lists and derives the booking's
  // payment_status from, so it must reflect what OCR actually decided.
  //
  // FIELD CONTRACT — read from Step4ReviewPayment's `resultObj`, which is what
  // `bookingData.payment.ocrData` actually holds:
  //
  //   valid        boolean  the backend's fail-fast verdict (result.valid)
  //   status       string   MATCHED | MISMATCHED | DUPLICATE_DETECTED |
  //                         NAME_MISMATCH | REJECTED |
  //                         MANUAL_REVIEW
  //   isManualReview boolean the OCR engine was unreachable; receipt is kept for
  //                          manual admin review
  //
  // NOTE: `isValidReceipt` is NOT a key on resultObj — it is renamed to `valid`
  // before storage. Reading the wrong key would have silently defaulted every
  // scan to FOR_VERIFICATION, which is precisely the bug being fixed here.
  //
  //   REJECTED          the image was not a usable receipt, or the amount/date/
  //                     name did not match — the RPC refuses the booking
  //   FOR_VERIFICATION  a usable receipt awaiting an admin decision
  //   PAID              only for an admin walk-in, whose payment is taken on site
  //   UNPAID            cash with no receipt to scan
  //
  // Deliberately NOT defaulted to FOR_VERIFICATION: a missing scan must not read
  // as "verified enough to book", and the RPC refuses an absent verdict.
  const ocrData = bookingData.payment?.ocrData || null;
  const ocrVerdict = (() => {
    if (isAdminWalkIn) return 'PAID';
    if (bookingData.payment?.method === 'Cash') return 'UNPAID';
    if (!ocrData) return null;

    // A server-supplied verdict wins when present (backend /api/ocr/audit).
    if (ocrData.verdict) return String(ocrData.verdict).toUpperCase();

    // The engine was unreachable and the receipt is being kept for a human.
    // That is a legitimate verification-queue entry, not a rejection.
    if (ocrData.isManualReview || ocrData.status === 'MANUAL_REVIEW') return 'FOR_VERIFICATION';

    // Any explicit mismatch verdict is a rejection.
    if (ocrData.status && ['MISMATCHED', 'DUPLICATE_DETECTED', 'NAME_MISMATCH', 'REJECTED'].includes(ocrData.status)) {
      return 'REJECTED';
    }

    // Otherwise the backend's own fail-fast flag decides.
    if (ocrData.valid === false) return 'REJECTED';
    if (ocrData.valid === true) return 'FOR_VERIFICATION';

    // No usable verdict at all — let the RPC refuse it rather than guessing.
    return null;
  })();

  const isReceivableWalkIn = isAdminWalkIn && bookingData.payment?.type === 'Receivable';

  if (isReceivableWalkIn) {
    // "To be received": no money changes hands now. The booking is created without a
    // payment and the database records the derived balance (admin_record_receivable).
    rpcPayment = null;
  } else if (isAdminWalkIn) {
    // Admin bookings are confirmed on-site by the admin themselves.
    // Payment is marked as PAID immediately and does not enter the verification queue.
    const paymentAmount = bookingData.payment?.type === 'Manual'
      ? Number(bookingData.payment?.manualAmount || 0)
      : bookingData.payment?.type === 'Downpayment'
        ? getRequiredDownpayment(totalAmount)
        : totalAmount;

    let receiptPublicUrl = null;
    if (bookingData.payment?.proofOfPayment) {
      try {
        const file = bookingData.payment.proofOfPayment;
        const filePath = `receipts/${Date.now()}-${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from('payment-receipts')
          .upload(filePath, file);
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('payment-receipts').getPublicUrl(filePath);
          receiptPublicUrl = publicUrl;
        }
      } catch (e) {
        console.warn('Admin receipt upload failed (non-fatal):', e);
      }
    }

    const payMethod = bookingData.payment?.method || 'Cash';
    const detectedRef = bookingData.payment?.ocrData?.referenceNo || null;
    const manualRef = bookingData.payment?.manualRefNumber || bookingData.payment?.referenceNumber || null;
    const finalRefNumber = String(manualRef || detectedRef || '').trim();

    rpcPayment = {
      amount: paymentAmount,
      method: payMethod,
      payment_type: bookingData.payment?.type || 'Full',
      status: 'PAID',
      verified_by: bookingData.adminActorId || null,
      verified_at: new Date().toISOString(),
      receipt_url: receiptPublicUrl,
      reference_number: finalRefNumber || null,
      detected_ref: detectedRef,
      detected_amount: bookingData.payment?.ocrData?.amount || null,
      notes: `ADMIN_CONFIRMED|METHOD:${payMethod}|TYPE:${bookingData.payment?.type || 'Full'}|AMOUNT:${paymentAmount}${finalRefNumber ? `|REF:${finalRefNumber}` : ''}`
    };
  } else if (bookingData.payment?.method === 'Cash') {
    const cashAmount = bookingData.payment.type === 'Downpayment' ? getRequiredDownpayment(totalAmount) : totalAmount;
    rpcPayment = {
      amount: cashAmount,
      method: 'Cash',
      payment_type: bookingData.payment.type || 'Full',
      status: 'PENDING',
      verified_by: null,
      verified_at: null,
      notes: `PAYMENT_CASH|TYPE:${bookingData.payment.type || 'Full'}|DECLARED_AMOUNT:${cashAmount}`
    };
  } else if (bookingData.payment?.method === 'GCash' && bookingData.payment.proofOfPayment) {
    const receiptPublicUrl = bookingData.payment?.ocrData?.receiptUrl;
    if (!receiptPublicUrl || !bookingData.payment?.ocrData?.ocrScanId) {
      throw new Error('The server-verified receipt session is missing. Scan the receipt again.');
    }

    const paymentAmount = bookingData.payment.type === 'Full' ? totalAmount : getRequiredDownpayment(totalAmount);
    // 🛠️ HOTFIX (Gross vs Net): the OCR now returns `amount` as the NET the
    // shop receives, plus the `grossAmount` the customer sent and the
    // `transferFee` that was deducted. We compare the NET against the required
    // amount (that is the real money), and we must NOT subtract the fee a
    // SECOND time when computing the net credit.
    const detectedAmount = Number(bookingData.payment?.ocrData?.amount || 0);
    const detectedGross = Number(bookingData.payment?.ocrData?.grossAmount || 0);
    const detectedReference = bookingData.payment?.ocrData?.referenceNo || null;
    const requiredDownpayment = getRequiredDownpayment(totalAmount);
    if (
      !bookingData.payment?.ocrData?.isManualReview &&
      detectedAmount < requiredDownpayment
    ) {
      throw new Error(`The detected payment amount must be at least ₱${requiredDownpayment.toLocaleString()} for the required downpayment.`);
    }

    // Task B: Net Payment Credit = the money the shop ACTUALLY received.
    // `detectedAmount` is ALREADY net (the OCR/service enforced gross − fee), so
    // we must not deduct the fee again. We only fall back to subtracting the fee
    // when the OCR gave us a GROSS figure without a net (legacy shape).
    const transferFee = Math.max(0, Number(bookingData.payment?.ocrData?.transferFee || 0));
    const netReceived = detectedAmount > 0        ? detectedAmount
      : (detectedGross > 0 ? Math.max(0, detectedGross - transferFee) : paymentAmount);
    const netCredit = netReceived;

    rpcPayment = {
      amount: paymentAmount,
      method: 'GCash',
      payment_type: bookingData.payment.type || 'Full',
      status: 'FOR_VERIFICATION',
      verdict: ocrVerdict,
      ocr_scan_id: bookingData.payment?.ocrData?.ocrScanId || null,
      receipt_url: receiptPublicUrl,
      detected_amount: detectedAmount > 0 ? detectedAmount : null,
      detected_ref: detectedReference,
      transfer_fee: transferFee,
      net_credit: netCredit,
      notes: `PAYMENT_DIGITAL|TYPE:${bookingData.payment.type || 'Full'}|DECLARED_AMOUNT:${paymentAmount}|OCR_NET:${detectedAmount > 0 ? detectedAmount : 'NULL'}|GROSS:${detectedGross > 0 ? detectedGross : 'NULL'}|FEE:${transferFee}|NET:${netCredit}`,
      reference_number: String(detectedReference || '').trim() || null
    };
  }

  // 1. Atomically create the master booking, its vehicles, their services, and
  //    the optional payment in a SINGLE transaction. Either every row lands or
  //    none do — a failure can never leave a phantom booking with missing
  //    children (the defect this RPC replaces).
  const { data: rpcResult, error: rpcError } = await supabase.rpc('create_booking_atomic_secure', {
    p_payload: {
      booking: {
        customer_id: bookingCustomerId,
        customer_name: bookingData.customerName,
        customer_email: bookingData.customerEmail || customerProfile?.email || null,
        start_datetime: combineDateAndTime(bookingData.date, bookingData.time),
        end_datetime: calculateEstimatedEnd(bookingData.date, bookingData.time, vehicles),
        status: initialBookingStatus,
        payment_status: isAdminWalkIn
          ? (rpcPayment && rpcPayment.amount >= totalAmount ? 'paid' : (rpcPayment && rpcPayment.amount > 0 ? 'partially_paid' : 'unpaid'))
          : undefined,
        total_amount: totalAmount,
        // EC-1: the master bookings.vehicle_type column must be populated. The
        // RPC derives it from the first vehicle as a fallback, but sending it
        // explicitly keeps the master row correct even if the vehicle order or
        // shape changes, and makes the intent unambiguous at the call site.
        vehicle_type: vehicles[0]?.type || null,
        applied_promo_id: appliedPromoId || null,
        promo_name_snapshot: promoNameSnapshot || null,
        promo_code: bookingData.promoCode || null,
        discount_amount_snapshot: discountAmountSnapshot,
        active_qr_snapshot: qrSnapshot,
        qr_snapshot_version: qrSnapshot?.qr_config_version ?? null,
        notes: [
          bookingData.notes,
          bookingData.fleetGroupId ? `FLEET_GROUP:${bookingData.fleetGroupId}` : '',
          packagePlan.length ? `PACKAGES:${JSON.stringify(packagePlan)}` : '',
        ].filter(Boolean).join(' | '),
        contact_number: bookingData.contactNumber,
        ocr_metadata: bookingData.payment?.ocrData || {},
        customer_first_name: bookingData.customerFirstName || null,
        customer_last_name: bookingData.customerLastName || null,
        service_snapshot: bookingServiceSnapshot,
        service_snapshot_version: 1,
        is_walk_in: isAdminWalkIn
      },
      vehicles: rpcVehicles,
      payment: rpcPayment
    }
  });

  if (rpcError) {
    console.error('Atomic Booking RPC Error:', rpcError);
    if (rpcError.code === '23505' && /unique_reference_number/i.test(rpcError.message || '')) {
      throw new Error('This payment transaction reference has already been used. Please check the receipt or enter the correct reference.');
    }
    throw new Error(`Master Booking Error: ${rpcError.message}`);
  }

  const booking = rpcResult?.booking;
  if (!booking?.id) {
    throw new Error('Master Booking Error: atomic creation returned no booking record.');
  }

  if (isReceivableWalkIn) {
    const { error: receivableError } = await supabase.rpc('admin_record_receivable', { p_booking_id: booking.id, p_note: 'Walk-in: to be received' });
    if (receivableError) {
      throw new Error(`The booking was created, but the amount to be received could not be recorded: ${receivableError.message}`);
    }
  }

  // Populate the customer's garage (non-fatal, per vehicle).
  if (bookingCustomerId) {
    void Promise.all(vehicles.map(async (vehicle) => {
      try {
        await fetch(`${BACKEND_URL}/api/garage/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: bookingCustomerId, vehicle })
        });
      } catch (garageEx) {
        console.warn('Silent Garage Sync Failure:', garageEx);
      }
    }));
  }

  const bookingRef = booking.id.substring(0, 8).toUpperCase();

  // A staff-created walk-in is already confirmed and its payment was recorded
  // as verified on site. Send the confirmation event so its itemised receipt
  // is attached; self-service bookings remain on the unverified submission
  // event until staff review the payment.
  //
  // This used to dispatch a "Payment Submitted" notification email AND a
  // separate SCHEDULED lifecycle email — two mails for one booking, quoting two
  // different amounts. The lifecycle email now carries the payment block and the
  // OCR detail, and the database enforces exactly-once per (booking, event), so
  // a retry or a double-tap cannot send it twice.
  //
  // The in-app notification is created by the same function, so the bell and
  // the inbox can never describe the same event differently.
  const emailEvent = isAdminWalkIn ? 'booking_confirmed' : 'booking_created';
  void sendStatusEmail(booking.id, emailEvent)
    .then(lifecycleEmailResult => {
      if (lifecycleEmailResult?.error) {
        console.warn(`[Booking] ${emailEvent} lifecycle email failed for ${booking.id}:`, lifecycleEmailResult.error);
      }
    })
    .catch(error => console.warn(`[Booking] ${emailEvent} lifecycle email failed for ${booking.id}:`, error));

  return booking;
};

/**
 * The booking's OVERALL FINANCIAL LEDGER, resolved server-side.
 *
 * Why this exists rather than being derived in the component:
 *
 * `calculatePaymentSummary` above is the canonical rule for RECOGNISED money and
 * it is correct — money only counts once it is PAID-family, never while
 * FOR_VERIFICATION. The consequence is that a customer's OCR-scanned receipt
 * contributes ₱0 to every financial total until an admin verifies it, so the
 * scan was effectively invisible to anyone looking only at the ledger.
 *
 * `booking_financial_ledger()` returns BOTH layers separately:
 *   settled_amount / outstanding_amount  -> recognised money (unchanged rule)
 *   pending_verification / pending_ocr_detected / ocr_variance
 *                                        -> claimed-but-unverified money,
 *                                           attributed and NOT counted as revenue
 *
 * Read-only. Returns null when the RPC is unavailable so a caller must decide
 * explicitly what to show, instead of silently rendering an empty ledger.
 */
export const fetchBookingFinancialLedger = async (bookingId) => {
  if (!bookingId) return null;
  const { data, error } = await supabase.rpc('booking_financial_ledger', { p_booking_id: bookingId });
  if (error) {
    console.error('[FinancialLedger] Failed to resolve the booking ledger:', {
      code: error.code,
      message: error.message,
    });
    return null;
  }
  return data || null;
};

/** Convenience: is there OCR-attributed money awaiting a human decision? */
export const hasPendingVerification = (ledger) => Boolean(ledger?.has_pending_verification);

/**
 * A short, unambiguous label for the ledger state, so the UI and any email say
 * the same thing. Deliberately never returns 'PAID' for unverified money.
 */
export const describeLedgerState = (ledger) => {
  if (!ledger) return { label: 'LEDGER UNAVAILABLE', tone: 'neutral' };
  if (ledger.has_discrepancy) {
    return { label: 'VERIFYING — DISCREPANCY', tone: 'warning' };
  }
  if (ledger.has_pending_verification) return { label: 'VERIFYING', tone: 'pending' };
  if (ledger.fully_settled) return { label: 'FULLY PAID', tone: 'success' };
  if (Number(ledger.net_settled) > 0) return { label: 'PARTIALLY PAID', tone: 'pending' };
  return { label: 'UNPAID', tone: 'danger' };
};

export default {
  fetchBookingFinancialLedger,
  hasPendingVerification,
  describeLedgerState,
};
export const fetchCustomerBookings = async (customerId) => {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      *,
      vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*)),
      payments:payments!payments_booking_id_fkey(*),
      assigned_staff:profiles!bookings_staff_id_fkey(first_name, last_name, email)
    `)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });

  if (error) {
    // This is a READ path. Its message used to say the booking "could not be
    // reserved" — copy that leaked from the reschedule flow — which was
    // misleading when simply loading the customer's booking list failed.
    console.error('[CustomerBookings] Failed to load bookings:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    throw new Error(error.message || 'We could not load your bookings right now. Please try again.');
  }
  // Attach each booking's ledger (paid, balance, status) in one request so no
  // customer screen has to sum payment rows itself.
  const bookings = data || [];
  let ledgers = new Map();
  try {
    ledgers = await fetchBookingLedgers(bookings.map((booking) => booking.id));
  } catch (ledgerError) {
    console.error('[CustomerBookings] Ledger load failed:', ledgerError);
  }
  return bookings.map((booking) => {
    const ledger = ledgers.get(booking.id) || null;
    return { ...booking, ledger, totalPaid: Number(ledger?.net_settled || 0) };
  });
};

/**
 * Fetch a single booking by ID for the customer detail view.
 */
export const fetchBookingById = async (bookingId) => {
  const { data, error } = await supabase
    .from('bookings')
    .select(`
      *,
      vehicles:booking_vehicles!booking_vehicles_booking_id_fkey(*, services:booking_vehicle_services!booking_vehicle_id(*)),
      payments:payments!payments_booking_id_fkey(*),
      assigned_staff:profiles!bookings_staff_id_fkey(first_name, last_name, email)
    `)
    .eq('id', bookingId)
    .single();

  if (error) throw error;
  return data;
};

/**
 * Subscribe to real-time changes on a specific booking.
 * Returns { unsubscribe } for the caller.
 */
export const subscribeToBooking = (bookingId, callback) => {
  const stop = subscribeTable({ table: 'bookings', filter: `id=eq.${bookingId}` }, callback);
  return { unsubscribe: stop };
};

/**
 * Subscribe to all bookings for a customer (for dashboard live updates).
 */
export const subscribeToCustomerBookings = (customerId, callback) => {
  const stop = subscribeTable({ table: 'bookings', filter: `customer_id=eq.${customerId}` }, callback);
  return { unsubscribe: stop };
};

// --- Utility ---

function combineDateAndTime(dateStr, timeStr) {
  return buildLocalDateTime(dateStr, timeStr);
}

export function calculateEstimatedEnd(dateStr, timeStr, vehicles = []) {
  try {
    const startIso = combineDateAndTime(dateStr, timeStr);
    const date = new Date(startIso);

    // Vehicles are serviced concurrently; use the longest unit duration.
    let totalMinutes = 0;
    vehicles.forEach(v => {
      const vehicleDuration = (v.services || []).reduce((sum, service) => sum + Number(service.durationMinutes || 60), 0);
      totalMinutes = Math.max(totalMinutes, vehicleDuration);
    });

    // Minimum duration of 1 hour if no services selected yet
    if (totalMinutes === 0) totalMinutes = 60;

    // Add the 1-hour cleanup/handover buffer (REQ-SYS-BUFFER)
    totalMinutes += SHOP_CONFIG.BOOKING_CLEANUP_BUFFER_MINUTES;

    date.setMinutes(date.getMinutes() + totalMinutes);

    if (isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  } catch (e) {
    return new Date().toISOString();
  }
}

/**
 * Request a cancellation/refund for a booking.
 */
export const cancelBooking = async (bookingId, reason) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Please sign in again before cancelling this booking.');

  const response = await fetch(`${BACKEND_URL}/api/bookings/cancel`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`
    },
    body: JSON.stringify({ bookingId, reason })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Failed to cancel booking.');
  }
  return result;
};

export const rescheduleBooking = async (bookingId, startDatetime, endDatetime, reason = null) => {
  if (startDatetime && typeof startDatetime === 'object') {
    const bookingData = startDatetime;
    startDatetime = combineDateAndTime(bookingData.date, bookingData.time);
    endDatetime = calculateEstimatedEnd(bookingData.date, bookingData.time, bookingData.vehicles || []);
  }

  const { data, error } = await supabase.rpc('reschedule_booking', {
    p_booking_id: bookingId,
    p_start_datetime: startDatetime,
    p_end_datetime: endDatetime,
    p_reason: reason || null
  });

  if (error) {
    console.error('[Reschedule] RPC failed:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    throw new Error(error.message || 'The selected appointment time could not be reserved.');
  }
  await sendStatusEmail(bookingId, 'scheduled');
  return data;
};