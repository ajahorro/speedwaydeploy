import { supabase } from '../lib/supabase';
import { emitEvent, EVENTS } from './eventEngine';
import { SHOP_CONFIG } from '../config/constants';
import { getEffectivePriceForService, calculateBookingDiscountSummary, buildBookingServiceSnapshot } from '../data/servicesCatalog';
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
  const bookingCustomerId = Object.prototype.hasOwnProperty.call(bookingData || {}, 'customerId')
    ? (bookingData.customerId ?? null)
    : (customerId ?? null);
  const vehicles = bookingData.vehicles || [];
  const { data: customerProfile } = bookingCustomerId
    ? await supabase.from('profiles').select('email').eq('id', bookingCustomerId).maybeSingle()
    : { data: null };

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
  if ((!bookingData.adminWalkIn && bookingData.payment?.method === 'Cash') || (bookingData.payment?.method === 'GCash' && bookingData.payment.proofOfPayment)) {
    if (bookingData.payment.method === 'Cash') {
      const cashAmount = bookingData.payment.type === 'Downpayment' ? getRequiredDownpayment(totalAmount) : totalAmount;
      rpcPayment = {
        amount: cashAmount,
        method: 'Cash',
        payment_type: bookingData.payment.type || 'Full',
        status: 'PENDING',
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
      const detectedAmount = Number(bookingData.payment?.ocrData?.amount || 0);
      const detectedReference = bookingData.payment?.ocrData?.referenceNo || null;
      const requiredDownpayment = getRequiredDownpayment(totalAmount);
      if (
        !bookingData.adminWalkIn &&
        !bookingData.payment?.ocrData?.isManualReview &&
        detectedAmount < requiredDownpayment
      ) {
        throw new Error(`The detected payment amount must be at least ₱${requiredDownpayment.toLocaleString()} for the required downpayment.`);
      }

      // Task B: Net Payment Credit = Total Deducted − Transfer Fee.
      const transferFee = Math.max(0, Number(bookingData.payment?.ocrData?.transferFee || 0));
      const grossCredited = detectedAmount > 0 ? detectedAmount : paymentAmount;
      const netCredit = Math.max(0, grossCredited - transferFee);
      rpcExcess = Math.max(0, netCredit - paymentAmount);

      rpcPayment = {
        amount: paymentAmount,
        method: 'GCash',
        payment_type: bookingData.payment.type || 'Full',
        status: 'FOR_VERIFICATION',
        receipt_url: publicUrl,
        detected_amount: detectedAmount > 0 ? detectedAmount : null,
        detected_ref: detectedReference,
        transfer_fee: transferFee,
        net_credit: netCredit,
        notes: `PAYMENT_DIGITAL|TYPE:${bookingData.payment.type || 'Full'}|DECLARED_AMOUNT:${paymentAmount}|OCR_AMOUNT:${detectedAmount > 0 ? detectedAmount : 'NULL'}|FEE:${transferFee}|NET:${netCredit}`,
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
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
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
    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
      await fetch(`${BACKEND_URL}/admin/generate-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bookingData.customerEmail, role: 'CUSTOMER' })
      });
    } catch (inviteError) {
      console.warn('Guest account invitation failed:', inviteError);
    }
  }

  const bookingRef = booking.id.substring(0, 8).toUpperCase();

  // EVENT: Payment Submitted — only for digital receipts awaiting verification.
  if (rpcPayment && rpcPayment.method === 'GCash') {
    await emitEvent(EVENTS.PAYMENT_SUBMITTED, {
      userId: bookingCustomerId,
      bookingId: booking.id,
      meta: { bookingRef, amount: rpcPayment.amount }
    });
  }

  // The lifecycle email is the single trigger; the status-email function also
  // creates the in-app notification once delivery succeeds. Walk-ins are already
  // confirmed, so they dispatch CONFIRMED instead of SCHEDULED.
  const lifecycleStatus = isAdminWalkIn ? 'confirmed' : 'scheduled';
  const lifecycleEmailResult = await sendStatusEmail(booking.id, lifecycleStatus);
  if (lifecycleEmailResult?.error) {
    console.warn(`[Booking] ${lifecycleStatus} lifecycle email failed for ${booking.id}:`, lifecycleEmailResult.error);
  }

  return booking;
};

/**
 * Fetch all bookings for a specific customer, with vehicles and payments.
 */
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