import { supabase } from '../lib/supabase';
import { emitEvent, EVENTS } from './eventEngine';
import { SHOP_CONFIG } from '../config/constants';
import { getEffectivePriceForService, calculateBookingDiscountSummary, buildBookingServiceSnapshot, validateServiceRequirements, describeServiceRequirementViolation } from '../data/servicesCatalog';
import { getRequiredDownpayment } from '../utils/paymentUtils';
import { sendStatusEmail } from './notificationService';
import { calculateBayUsage } from '../utils/schedulingUtils';

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

  const { data: capacityConfig } = await supabase.from('business_config').select('slots_per_hour').maybeSingle();
  const maxBays = Number(capacityConfig?.slots_per_hour || SHOP_CONFIG.MAX_BAYS);
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
  const appliedPromoId = appliedPackages.length
    ? appliedPackages[0].packageId
    : (() => {
        // For standard promos, find the first promo applied on any service line.
        for (const vehicle of (vehicles || [])) {
          for (const service of (vehicle.services || [])) {
            if (service?.applied_promo) return service.applied_promo;
          }
        }
        return null;
      })();
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
  const isAdminWalkIn = Boolean(bookingData.adminWalkIn);
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
      status: 'SCHEDULED'
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
  let rpcExcess = 0;

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
  //                         NAME_MISMATCH | DATE_MISMATCH | REJECTED |
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
    if (bookingData.payment?.method === 'Cash') return isAdminWalkIn ? 'PAID' : 'UNPAID';
    if (!ocrData) return null;

    // A server-supplied verdict wins when present (backend /api/ocr/audit).
    if (ocrData.verdict) return String(ocrData.verdict).toUpperCase();

    // The engine was unreachable and the receipt is being kept for a human.
    // That is a legitimate verification-queue entry, not a rejection.
    if (ocrData.isManualReview || ocrData.status === 'MANUAL_REVIEW') return 'FOR_VERIFICATION';

    // Any explicit mismatch verdict is a rejection.
    if (ocrData.status && ['MISMATCHED', 'DUPLICATE_DETECTED', 'NAME_MISMATCH', 'DATE_MISMATCH', 'REJECTED'].includes(ocrData.status)) {
      return 'REJECTED';
    }

    // Otherwise the backend's own fail-fast flag decides.
    if (ocrData.valid === false) return 'REJECTED';
    if (ocrData.valid === true) return 'FOR_VERIFICATION';

    // No usable verdict at all — let the RPC refuse it rather than guessing.
    return null;
  })();
  if ((bookingData.adminWalkIn && bookingData.payment?.method === 'Cash') || (!bookingData.adminWalkIn && bookingData.payment?.method === 'Cash') || (bookingData.payment?.method === 'GCash' && bookingData.payment.proofOfPayment)) {
    if (bookingData.payment.method === 'Cash') {
      const cashAmount = bookingData.adminWalkIn && bookingData.payment.type === 'Manual'
        ? Number(bookingData.payment.manualAmount || 0)
        : bookingData.payment.type === 'Downpayment' ? getRequiredDownpayment(totalAmount) : totalAmount;
      rpcPayment = {
        amount: cashAmount,
        method: 'Cash',
        payment_type: bookingData.payment.type || 'Full',
        status: bookingData.adminWalkIn ? 'PAID' : 'PENDING',
        verified_by: bookingData.adminWalkIn ? bookingData.adminActorId || null : null,
        verified_at: bookingData.adminWalkIn ? new Date().toISOString() : null,
        notes: `PAYMENT_CASH|TYPE:${bookingData.payment.type || 'Full'}|DECLARED_AMOUNT:${cashAmount}`
      };
    } else {
      const file = bookingData.payment.proofOfPayment;
      const fileExt = file.name.split('.').pop();
      const filePath = `receipts/${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from('payment-receipts')
        .upload(filePath, file);

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage.from('payment-receipts').getPublicUrl(filePath);

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
        !bookingData.adminWalkIn &&
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
      rpcExcess = Math.max(0, netCredit - paymentAmount);

      rpcPayment = {
        amount: paymentAmount,
        method: 'GCash',
        payment_type: bookingData.payment.type || 'Full',
        status: 'FOR_VERIFICATION',
        // ── OCR VERDICT ──────────────────────────────────────────────────────
        // create_booking_atomic allow-lists this value and DERIVES the booking's
        // payment_status from it. The OCR is meant to be a source of truth, and
        // this is the only point at which its verdict can reach the database —
        // the payment row does not exist yet at RPC time, so the verdict cannot
        // be read from there.
        //
        // A rejected verdict makes the RPC refuse the booking outright, which is
        // what stops a non-receipt image from completing one. An unrecognised
        // value is refused too, so a caller cannot smuggle a bad string into the
        // enum column.
        verdict: ocrVerdict,
        receipt_url: publicUrl,
        detected_amount: detectedAmount > 0 ? detectedAmount : null,
        detected_ref: detectedReference,
        transfer_fee: transferFee,
        net_credit: netCredit,
        notes: `PAYMENT_DIGITAL|TYPE:${bookingData.payment.type || 'Full'}|DECLARED_AMOUNT:${paymentAmount}|OCR_NET:${detectedAmount > 0 ? detectedAmount : 'NULL'}|GROSS:${detectedGross > 0 ? detectedGross : 'NULL'}|FEE:${transferFee}|NET:${netCredit}`,
        reference_number: detectedReference || ''
      };
    }
  }

  // 1. Atomically create the master booking, its vehicles, their services, and
  //    the optional payment in a SINGLE transaction. Either every row lands or
  //    none do — a failure can never leave a phantom booking with missing
  //    children (the defect this RPC replaces).
  const { data: rpcResult, error: rpcError } = await supabase.rpc('create_booking_atomic', {
    p_payload: {
      booking: {
        customer_id: bookingCustomerId,
        customer_name: bookingData.customerName,
        customer_email: bookingData.customerEmail || customerProfile?.email || null,
        start_datetime: combineDateAndTime(bookingData.date, bookingData.time),
        end_datetime: calculateEstimatedEnd(bookingData.date, bookingData.time, vehicles),
        status: initialBookingStatus,
        total_amount: totalAmount,
        // EC-1: the master bookings.vehicle_type column must be populated. The
        // RPC derives it from the first vehicle as a fallback, but sending it
        // explicitly keeps the master row correct even if the vehicle order or
        // shape changes, and makes the intent unambiguous at the call site.
        vehicle_type: vehicles[0]?.type || null,
        applied_promo_id: appliedPromoId || null,
        promo_name_snapshot: promoNameSnapshot || null,
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
    throw new Error(`Master Booking Error: ${rpcError.message}`);
  }

  const booking = rpcResult?.booking;
  if (!booking?.id) {
    throw new Error('Master Booking Error: atomic creation returned no booking record.');
  }

  // Task B: bank any surplus as excess_credit on the ledger (non-fatal). The
  // payment row was already written transactionally above.
  if (rpcExcess > 0 && bookingCustomerId) {
    try {
      const { recordExcessCredit } = await import('./creditLedgerService');
      await recordExcessCredit(bookingCustomerId, booking.id, rpcExcess, 'Overpayment surplus on GCash receipt');
    } catch (creditErr) {
      console.warn('Excess credit recording failed (non-fatal):', creditErr);
    }
  }

  // Populate the customer's garage (non-fatal, per vehicle).
  if (bookingCustomerId) {
    for (const vehicle of vehicles) {
      try {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
        await fetch(`${BACKEND_URL}/api/garage/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerId: bookingCustomerId, vehicle })
        });
      } catch (garageEx) {
        console.warn('Silent Garage Sync Failure:', garageEx);
      }
    }
  }

  if (!bookingCustomerId && bookingData.customerEmail) {
    // Only invite an account-less guest when no existing profile already owns
    // that email — otherwise we would re-invite an existing customer and hit
    // the profiles email uniqueness constraint (Scenario 1).
    const normalizedEmail = String(bookingData.customerEmail).trim().toLowerCase();
    try {
      const { data: existingAccount } = await supabase
        .from('profiles')
        .select('id')
        .ilike('email', normalizedEmail)
        .maybeSingle();
      if (existingAccount?.id) {
        console.warn('[Booking] Skipped guest invite — email already belongs to a registered account.');
      } else {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
        await fetch(`${BACKEND_URL}/admin/generate-invite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: bookingData.customerEmail, role: 'CUSTOMER' })
        });
      }
    } catch (inviteError) {
      console.warn('Guest account invitation failed:', inviteError);
    }
  }

  const bookingRef = booking.id.substring(0, 8).toUpperCase();

  // ONE email for this whole submission.
  //
  // This used to dispatch a "Payment Submitted" notification email AND a
  // separate SCHEDULED lifecycle email — two mails for one booking, quoting two
  // different amounts. The lifecycle email now carries the payment block and the
  // OCR detail, and the database enforces exactly-once per (booking, event), so
  // a retry or a double-tap cannot send it twice.
  //
  // The in-app notification is created by the same function, so the bell and
  // the inbox can never describe the same event differently.
  const lifecycleEmailResult = await sendStatusEmail(booking.id, 'booking_created');
  if (lifecycleEmailResult?.error) {
    console.warn(`[Booking] Creation lifecycle email failed for ${booking.id}:`, lifecycleEmailResult.error);
  }

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
  return data || [];
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
 * Returns the channel so the caller can unsubscribe.
 */
export const subscribeToBooking = (bookingId, callback) => {
  const channel = supabase
    .channel(`booking-${bookingId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'bookings',
      filter: `id=eq.${bookingId}`
    }, callback)
    .subscribe();

  return channel;
};

/**
 * Subscribe to all bookings for a customer (for dashboard live updates).
 */
export const subscribeToCustomerBookings = (customerId, callback) => {
  const channel = supabase
    .channel(`customer-bookings-${customerId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'bookings',
      filter: `customer_id=eq.${customerId}`
    }, callback)
    .subscribe();

  return channel;
};

// --- Utility ---

function combineDateAndTime(dateStr, timeStr) {
  if (!dateStr) return new Date().toISOString();
  if (!timeStr) return `${dateStr}T00:00:00Z`;

  try {
    const [time, meridian] = timeStr.split(' ');
    let [hours, minutes = 0] = time.split(':').map(Number);
    if (meridian === 'PM' && hours !== 12) hours += 12;
    if (meridian === 'AM' && hours === 12) hours = 0;

    // Construct Date in local timezone, then convert to UTC ISO string
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day, hours, minutes, 0);

    if (isNaN(d.getTime())) throw new Error('Invalid Date');
    return d.toISOString();
  } catch (e) {
    return `${dateStr}T12:00:00Z`; // Fallback
  }
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
  try {
    // 1. Fetch the booking using maybeSingle() to prevent hard 404 crashes
    const { data: booking, error: fetchError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', bookingId)
      .maybeSingle();

    if (fetchError) throw fetchError;

    // 🛡️ Defensive Check: If the booking doesn't exist or RLS blocks it
    if (!booking) {
      throw new Error(`Booking ID ${bookingId} not found. It may have been deleted, or you do not have permission to access it.`);
    }

    // 2. Update booking status to 'cancelled' and append reason to notes
    const updatedNotes = booking.notes
      ? `${booking.notes}\nCancellation Reason: ${reason}`
      : `Cancellation Reason: ${reason}`;

    const { error: updateError } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        refund_status: 'QUEUED',
        staff_id: null,
        cancellation_reason: reason,
        notes: updatedNotes
      })
      .eq('id', bookingId);

    if (updateError) throw updateError;

    // 3. Mark all related vehicles as cancelled to free up the queue
    const { error: vehicleError } = await supabase
      .from('booking_vehicles')
      .update({ status: 'cancelled' })
      .eq('booking_id', bookingId);

    if (vehicleError) console.warn('Non-fatal error updating vehicles:', vehicleError);

    // 4. Mark associated active payments as REFUND_PENDING
    const { data: payments } = await supabase
      .from('payments')
      .select('id, status')
      .eq('booking_id', bookingId);

    if (payments && payments.length > 0) {
      for (const p of payments) {
        if (p.status === 'PAID' || p.status === 'FOR_VERIFICATION') {
          await supabase
            .from('payments')
            .update({ status: 'REFUND_PENDING' })
            .eq('id', p.id);
        }
      }
    }

    // The lifecycle email is the single cancellation dispatcher. It creates the
    // in-app notification only after the email is delivered successfully.
    const cancellationEmail = await sendStatusEmail(bookingId, 'cancelled', reason);
    if (cancellationEmail?.error) {
      console.warn(`[Booking] Cancellation email failed for ${bookingId}:`, cancellationEmail.error);
    }

    return { success: true };
  } catch (err) {
    console.error('Error cancelling booking:', err.message || err);
    throw err;
  }
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