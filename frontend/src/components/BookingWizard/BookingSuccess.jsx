import React, { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CheckCircle, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import PaymentReceipt from '../PaymentReceipt';
import { calculateBookingDiscountSummary } from '../../data/servicesCatalog';

const BookingSuccess = ({ bookingData }) => {
  const navigate = useNavigate();

  // The total is the one the payment step quoted: packages at their flat price, ordinary promos applied per
  // service, and a promo code taken off the order once. Summing base prices (as this screen used to) showed the
  // full price on the receipt even though the customer was charged the discounted amount.
  const promoReferenceDate = bookingData.createdAt || bookingData.created_at || bookingData.submittedAt || null;
  const grandTotal = calculateBookingDiscountSummary(bookingData.vehicles || [], promoReferenceDate, bookingData.promoRule || null).discountedTotal
    || bookingData.totalAmount || 0;

  // PaymentReceipt reads a `booking` object plus a `vehicles` array — NOT the
  // flat `items` / `customerName` / `subtotal` prop set this screen used to pass.
  // That mismatch left `booking` undefined inside the receipt, so `subtotal`
  // resolved to `Number(undefined?.total_amount ?? 0)` = 0 and `rows` fell back
  // to the hardcoded placeholder name — rendering a receipt where the item name
  // was right but EVERY price (unit, subtotal, VAT, total) was ₱0.00. The wizard
  // already holds the authoritative figures, so map them into the shape the
  // receipt actually consumes rather than inventing a second pricing path.
  const receiptBooking = {
    id: bookingData.bookingId || bookingData.reference || null,
    created_at: new Date().toISOString(),
    total_amount: grandTotal,
    customer_name: bookingData.customerName || 'Valued Customer',
    customer_email: bookingData.email || null,
    // A package booking carries its money on the VEHICLE (`package_price`),
    // while its individual service lines are deliberately zero-priced. Summing
    // the lines alone would under-report a bundle as ₱0, so the frozen package
    // figure is preferred when one was applied.
    vehicles: (bookingData.vehicles || []).map((v) => ({
      ...v,
      services: (v.services || []).map((s) => ({
        ...s,
        price_at_booking: Number(
          s.price_at_booking ?? (v.package_applied ? v.package_price : s.price) ?? 0
        ),
        service_name: s.name || s.service_name || s.service_name_snapshot || 'Service',
      })),
    })),
  };

  // Once saved, show the booking as the database has it: booking number, contact details and any payment
  // already recorded (a walk-in paid in full shows CASH ticked and Fully paid), not the wizard's draft copy.
  const [saved, setSaved] = useState(null);
  useEffect(() => {
    const id = receiptBooking.id;
    if (!id) return undefined;
    let cancelled = false;
    (async () => {
      const [{ data: b }, { data: vs }, { data: ps }] = await Promise.all([
        supabase.from('bookings').select('*').eq('id', id).maybeSingle(),
        supabase.from('booking_vehicles').select('*').eq('booking_id', id).order('created_at'),
        supabase.from('payments').select('*').eq('booking_id', id).neq('method', 'RECEIVABLE').order('created_at'),
      ]);
      if (!b || cancelled) return;
      const { data: ss } = vs?.length ? await supabase.from('booking_vehicle_services').select('*').in('booking_vehicle_id', vs.map((v) => v.id)) : { data: [] };
      if (cancelled) return;
      const vehicles = (vs || []).map((v) => ({ ...v, services: (ss || []).filter((s) => s.booking_vehicle_id === v.id) }));
      setSaved({ ...b, payments: ps || [], vehicles: vehicles.length ? vehicles : receiptBooking.vehicles });
    })();
    return () => { cancelled = true; };
  }, [receiptBooking.id]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '2rem', gap: '2rem' }}>
      <div className="no-print" style={{ textAlign: 'center' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(var(--admin-success-rgb), 0.1)', marginBottom: '1rem' }}>
          <CheckCircle size={40} color="var(--admin-success)" />
        </div>
        <h1 style={{ fontSize: '2rem', fontWeight: '950', color: 'var(--admin-text-on-brand)', margin: 0, textTransform: 'uppercase' }}>Booking Logged!</h1>
        <p style={{ color: 'var(--admin-text-secondary)', fontWeight: '600', marginTop: '0.5rem' }}>Your appointment has been saved. Here is your booking summary.</p>
      </div>

      <PaymentReceipt
        booking={saved || receiptBooking}
        vehicles={(saved || receiptBooking).vehicles}
        onClose={() => navigate('/customer')}
        mode="modal"
      />
    </div>
  );
};

export default BookingSuccess;
