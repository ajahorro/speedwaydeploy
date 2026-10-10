import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { subscribeTables } from '../../lib/realtimeHub';
import { useAuth } from '../../hooks/useAuth';
import {
  ArrowLeft, Clock, Car, ShieldCheck,
  CreditCard, FileText, MessageCircle, ChevronRight, AlertCircle, Package, Printer, CheckCircle2, X
} from 'lucide-react';
import toast from '@/lib/toast';
import { cancelBooking, rescheduleBooking } from '../../services/bookingService';
import { getStatusColor } from '../../utils/bookingHelpers';
import { useUnifiedData } from '../../context/UnifiedContext';
import { useGlobalChat } from '../../context/ChatContext';
import BookingSummaryHeader from '../../components/BookingSummaryHeader';
import OfficialReceipt from '../../components/OfficialReceipt';
import QRMagnifier from '../../components/QRMagnifier';
import PhotoProofGallery from '../../components/Photos/PhotoProofGallery';
import { useConfig } from '../../context/ConfigContext';
import CustomCalendar from '../../components/BookingWizard/CustomCalendar';
import TimeSlotPicker from '../../components/TimeSlotPicker';
import ValidationModal from '../../components/ValidationModal';
import { classifyScheduleError, toCleanMessage } from '../../utils/errorRouting';
import { calculateBayUsage } from '../../utils/schedulingUtils';
import { calculatePaymentSummary } from '../../utils/paymentUtils';
import { fetchBookingLedger } from '../../services/ledgerService';
import { resolveFrozenServicePrice } from '../../data/servicesCatalog';
import { getAvailableSlots, getBusinessHours } from '../../services/scheduleService';
import { useImagePreview } from '../../context/ImagePreviewContext';
import PaymentProofModal from '../../components/payments/PaymentProofModal';
import AddServiceDialog from '../../components/payments/AddServiceDialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const CustomerBookingDetails = () => {
  const { openImage } = useImagePreview();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refreshData } = useUnifiedData(); // Now safely inside the component!
  const { setActiveBookingId, openChatForBooking } = useGlobalChat();
  const { settings } = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    setActiveBookingId(id);
    return () => setActiveBookingId(null);
  }, [id, setActiveBookingId]);

  // Deep links from notifications and the chat digest land on
  // /bookings/:id?chat=open. Without this the thread was highlighted but the
  // panel stayed shut, so "Open chat" appeared to do nothing.
  useEffect(() => {
    if (!id || searchParams.get('chat') !== 'open') return;
    openChatForBooking(id);
    const next = new URLSearchParams(searchParams);
    next.delete('chat');
    setSearchParams(next, { replace: true });
  }, [id, searchParams, openChatForBooking, setSearchParams]);

  const [payBalanceOpen, setPayBalanceOpen] = useState(false);
  const [addServiceOpen, setAddServiceOpen] = useState(false);
  const [booking, setBooking] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showRescheduleModal, setShowRescheduleModal] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState('');
  const [rescheduleTime, setRescheduleTime] = useState('');
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [receiptModal, setReceiptModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [rescheduleSlots, setRescheduleSlots] = useState([]);
  const [rescheduleSlotsLoading, setRescheduleSlotsLoading] = useState(false);
  const [businessHours, setBusinessHours] = useState(null);
  // Batch 7 / Step 7.3: a schedule conflict (capacity/lead-time/past-date) is a
  // DECISION the user must act on, so it routes to <ValidationModal>, not a
  // toast. Transient/operational failures keep using toasts.
  const [rescheduleIssue, setRescheduleIssue] = useState(null);
  // Batch 5: photo evidence drawer (customer sees only their own booking's photos via RLS).
  const [photoGalleryOpen, setPhotoGalleryOpen] = useState(false);
  const [photoGalleryVehicleId, setPhotoGalleryVehicleId] = useState(null);

  const formatCurrency = (val) => new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(val);

  // confirmCancellation now lives INSIDE the component where it has access to all state and hooks!
  const confirmCancellation = async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    const toastId = toast.loading('Processing cancellation...');
    try {
      const result = await cancelBooking(id, cancelReason);

      if (result.success) {
        toast.success(
          Number(result.refund_amount || 0) > 0
            ? 'Booking cancelled; payment moved to the Refund Hub.'
            : 'Booking cancelled; no payment was eligible for refund.',
          { id: toastId }
        );
        (result.warnings || []).forEach((warning) => toast.error(warning));
        setShowCancelModal(false);
        setCancelReason('');

        await refreshData(); // Triggers the global context refresh instantly!

        fetchAll();
      } else {
        throw new Error(result.error);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to cancel booking', { id: toastId });
    } finally {
      setIsCancelling(false);
    }
  };

  const openRescheduleModal = () => {
    const start = booking?.start_datetime ? new Date(booking.start_datetime) : new Date();
    setRescheduleDate(`${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`);
    setRescheduleTime(`${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`);
    setRescheduleSlots([]);
    setShowRescheduleModal(true);
  };

  useEffect(() => {
    if (!showRescheduleModal || !rescheduleDate || !booking?.id) return;
    let active = true;
    const durationMinutes = Math.max(60, Math.ceil((new Date(booking.end_datetime) - new Date(booking.start_datetime)) / 60000));
    const requestedBays = Math.max(1, calculateBayUsage(vehicles || []));
    setRescheduleSlotsLoading(true);
    Promise.all([
      getAvailableSlots(rescheduleDate, durationMinutes, vehicles, booking.id, { requestedBays }),
      getBusinessHours()
    ]).then(([slots, hours]) => {
      if (!active) return;
      setRescheduleSlots(slots);
      setBusinessHours(hours);
      setRescheduleTime(currentTime => (
        currentTime && !slots.some(slot => slot.time === currentTime) ? '' : currentTime
      ));
    }).catch(() => {
      if (active) setRescheduleSlots([]);
    }).finally(() => {
      if (active) setRescheduleSlotsLoading(false);
    });
    return () => { active = false; };
  }, [showRescheduleModal, rescheduleDate, booking?.id, booking?.start_datetime, booking?.end_datetime, vehicles]);

  const confirmReschedule = async () => {
    if (!rescheduleDate || !rescheduleTime || isRescheduling) return;
    setIsRescheduling(true);
    const toastId = toast.loading('Rescheduling appointment...');
    try {
      const [clock, meridian] = rescheduleTime.split(' ');
      let [hours, minutes] = clock.split(':').map(Number);
      if (meridian === 'PM' && hours !== 12) hours += 12;
      if (meridian === 'AM' && hours === 12) hours = 0;
      const [year, month, day] = rescheduleDate.split('-').map(Number);
      const start = new Date(year, month - 1, day, hours, minutes, 0);
      if (Number.isNaN(start.getTime()) || start <= new Date()) {
        throw new Error('Choose a future date and time for the appointment.');
      }
      const originalStart = new Date(booking.start_datetime);
      const originalEnd = new Date(booking.end_datetime);
      const durationMs = Math.max(originalEnd - originalStart, 60 * 60 * 1000);
      const end = new Date(start.getTime() + durationMs);
      await rescheduleBooking(booking.id, start.toISOString(), end.toISOString());
      toast.success('Appointment rescheduled. Payment was preserved and bay/staff allocation was released.', { id: toastId });
      setShowRescheduleModal(false);
      await refreshData();
      fetchAll();
    } catch (err) {
      const code = classifyScheduleError(err);
      if (code) {
        // Scheduling conflict → guided <ValidationModal> (fail-closed policy:
        // the reschedule did NOT go through).
        setRescheduleIssue({ code, message: toCleanMessage(err), date: rescheduleDate, time: rescheduleTime });
        toast.dismiss(toastId);
      } else {
        toast.error(err.message || 'Failed to reschedule appointment', { id: toastId });
      }
    } finally {
      setIsRescheduling(false);
    }
  };

  // --- DATA FETCHING ---
  const fetchAll = async () => {
    setLoading(true);
    try {
      let actualBookingId = id;

      // 0. Handle short reference code lookups gracefully
      if (id && id.length <= 12 && !id.includes('-')) {
        const { data: refData, error: refErr } = await supabase
          .from('bookings')
          .select('id')
          .ilike('id', `${id}%`)
          .maybeSingle();

        if (refErr || !refData) {
          navigate('/customer/bookings');
          return;
        }
        actualBookingId = refData.id;
      }

      // 1. Booking
      const { data: bData, error: bErr } = await supabase
        .from('bookings').select('*').eq('id', actualBookingId).maybeSingle();
      if (bErr) throw bErr;
      if (!bData) return navigate('/customer/bookings');

      // 2. Technicians: one per vehicle (the customer can read their names through this function only)
      const { data: technicianRows, error: technicianError } = await supabase.rpc('get_customer_booking_technicians', {
        p_booking_id: actualBookingId,
      });
      if (technicianError) throw technicianError;
      const technicianByVehicle = Object.fromEntries((technicianRows || []).map((row) => [row.vehicle_id, row.technician_name || null]));
      const distinctTechnicians = [...new Set(Object.values(technicianByVehicle).filter(Boolean))];
      const staff = distinctTechnicians.length ? { full_name: distinctTechnicians.join(', ') } : null;

      // 3. Fetch Vehicles (Manual Join)
      const { data: vData, error: vError } = await supabase
        .from('booking_vehicles')
        .select('*')
        .eq('booking_id', actualBookingId)
        .order('created_at');

      if (vError) throw vError;

      let vehiclesWithServices = [];
      if (vData && vData.length > 0) {
        const vehicleIds = vData.map(v => v.id);
        const { data: sData } = await supabase
          .from('booking_vehicle_services')
          .select('*')
          .in('booking_vehicle_id', vehicleIds);

        vehiclesWithServices = vData.map(v => ({
          ...v,
          services: (sData || []).filter(s => s.booking_vehicle_id === v.id)
        }));
      }

      // 4. Payments
      const { data: pData } = await supabase
        .from('payments').select('*').eq('booking_id', actualBookingId).neq('method', 'RECEIVABLE').order('created_at', { ascending: true });

      const processedPayments = (pData || []).map(p => {
        let url = p.receipt_url;
        if (url && !url.startsWith('http')) {
          const { data: { publicUrl } } = supabase.storage.from('payment-receipts').getPublicUrl(url);
          url = publicUrl;
        }
        return { ...p, receipt_url: url };
      });

      // Booking money comes from the database ledger, never from summing rows here.
      const ledger = await fetchBookingLedger(id).catch((ledgerError) => {
        console.error('Ledger load failed:', ledgerError);
        return null;
      });

      const vehicleTechnicians = vehiclesWithServices.map((vehicleRow) => ({
        vehicleId: vehicleRow.id,
        label: `${vehicleRow.brand || ''} ${vehicleRow.model || ''}`.trim() || vehicleRow.plate_number || 'Vehicle',
        name: technicianByVehicle[vehicleRow.id] || null
      }));
      setBooking({ ...bData, assigned_staff: staff, vehicle_technicians: vehicleTechnicians, ledger, totalPaid: Number(ledger?.net_settled || 0) });
      setVehicles(vehiclesWithServices);
      setPayments(processedPayments);
    } catch (err) {
      console.error('Fetch error:', err);
      toast.error('Failed to load booking.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    let timer = null;
    const refetch = () => { clearTimeout(timer); timer = setTimeout(fetchAll, 350); };
    const stopRealtime = subscribeTables([
      { table: 'bookings', filter: `id=eq.${id}` },
      { table: 'payments', filter: `booking_id=eq.${id}` },
      { table: 'booking_vehicles', filter: `booking_id=eq.${id}` }
    ], refetch);
    return () => { clearTimeout(timer); stopRealtime(); };
  }, [id]); // eslint-disable-line

  // --- STYLES ---
  const cardStyle = { background: 'var(--admin-card)', borderRadius: 'var(--admin-radius-lg)', border: '1px solid var(--admin-border)', padding: '1.5rem', boxShadow: 'var(--admin-card-shadow)' };
  const labelStyle = { fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '0.25rem' };
  const valStyle = { fontSize: '0.95rem', fontWeight: '900', color: 'var(--admin-text-primary)' };

  // Status color now from shared helper (bookingHelpers.js)

  if (loading || !booking) {
    return (
      <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--admin-brand)', fontWeight: '900' }}>
        Loading booking details...
      </div>
    );
  }

  const dt = booking.start_datetime ? new Date(booking.start_datetime) : null;
  const dateStr = dt ? dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'TBD';
  const timeStr = dt ? dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
  const paymentSummary = calculatePaymentSummary({ ...booking, payments });
  const totalPaid = paymentSummary.totalPaid || 0;
  const appliedToBooking = Math.max(0, totalPaid - Number(paymentSummary.credit || 0));
  const excessCredit = Number(paymentSummary.credit || 0);
  const balance = paymentSummary.balance;
  // What the customer can still pay now: the balance minus anything already sent for verification.
  const payableBalance = Math.max(0, Number(booking.ledger?.submitted_balance_due ?? balance) || 0);
  const awaitingVerification = Math.max(0, Number(booking.ledger?.pending_net_received ?? booking.ledger?.pending_verification ?? 0) || 0);
  const bookingIsOpenForPayment = !['cancelled', 'completed', 'released', 'flagged_noshow', 'no_show'].includes(String(booking.status || '').toLowerCase());
  const canPayBalance = balance > 0 && payableBalance > 0 && bookingIsOpenForPayment;
  const selectedRescheduleSlot = rescheduleSlots.some(slot => slot.time === rescheduleTime);

  // 🚀 DERIVED STATE: Ensure UI reflects reality even if master status lags
  const vehicleStatuses = (vehicles || []).map(v => v.status?.toUpperCase());
  const anyUnitStarted = vehicleStatuses.includes('IN_PROGRESS');
  const allUnitsFinished = vehicleStatuses.length > 0 && vehicleStatuses.every(s => s === 'COMPLETED' || s === 'CANCELLED');
  const isFullySettled = Boolean(booking.ledger?.fully_settled);

  // Real-time derived status for UI responsiveness
  let derivedStatus = (booking.status || 'scheduled').toLowerCase();

  // Auto-advance logic for UI
  if (anyUnitStarted && derivedStatus === 'scheduled') derivedStatus = 'in_progress';

  // Hard completion: All units done AND payment settled
  if (allUnitsFinished && isFullySettled && derivedStatus !== 'cancelled') derivedStatus = 'completed';

  const canCancelBooking = ['scheduled', 'confirmed'].includes(derivedStatus)
    && !vehicleStatuses.some(status =>
      ['IN_PROGRESS', 'ONGOING', 'COMPLETED', 'RELEASED'].includes(status)
    );

  // A service can be added until the booking is over: before and while the work is under way, never after it is
  // finished, cancelled, refunded or flagged. Vehicles that are already finished take no more services.
  const addableVehicles = (vehicles || []).filter((vehicle) => !['COMPLETED', 'RELEASED', 'CANCELLED'].includes(String(vehicle.status || '').toUpperCase()));
  const canAddService = ['scheduled', 'confirmed', 'in_progress', 'ongoing'].includes(derivedStatus)
    && addableVehicles.length > 0
    && !['REFUNDED', 'REFUND_PENDING'].includes(String(booking.refund_status || '').toUpperCase());

  const summaryBooking = {
    ...booking,
    status: derivedStatus,
    assigned_staff: booking.assigned_staff
      ? { ...booking.assigned_staff, full_name: booking.assigned_staff.full_name || `${booking.assigned_staff.first_name || ''} ${booking.assigned_staff.last_name || ''}`.trim() }
      : null
  };

  return (
    <>
      <style>{`
        .customer-booking-columns {
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
          gap: 1.5rem;
          align-items: start;
        }
        .billing-balance-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(240px, .8fr);
          gap: 1.5rem;
          align-items: start;
        }
        @media (max-width: 900px) {
          .customer-booking-columns,
          .billing-balance-grid {
            grid-template-columns: minmax(0, 1fr);
          }
        }
      `}</style>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '5rem' }}>

      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Button type="button" variant="outline" size="icon" onClick={() => navigate(-1)} aria-label="Go back"><ArrowLeft /></Button>
        <div>
          <div style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>Booking Reference</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-text-primary)', fontFamily: 'monospace' }}>#{id.substring(0, 8).toUpperCase()}</h1>
            {['confirmed', 'completed'].includes(booking.status) && (
              <Button onClick={() => navigate(`/customer/receipt/${id}`)} variant="outline" size="sm" className="uppercase">
                <Printer size={12} /> Print Official Receipt
              </Button>
            )}
          </div>
        </div>
      </div>

      <BookingSummaryHeader
        booking={summaryBooking}
        showCustomer={false}
        showTechnician
        paymentStatus={paymentSummary}
      />

      {/* ===== A. BOOKING STATUS ===== */}
      {booking.refund_status === 'PROCESSED' && (
        <div style={cardStyle}>
          <div style={{
            marginBottom: '1.5rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.05)',
            border: '1px solid #ef4444', borderRadius: 'var(--admin-radius-sm)',
            display: 'flex', alignItems: 'center', gap: '1rem'
          }}>
            <ShieldCheck color="var(--status-danger)" size={24} />
            <div>
              <div style={{ fontWeight: '950', color: 'var(--status-danger)', fontSize: '0.9rem', textTransform: 'uppercase' }}>Financial Reversal Finalized</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: '600' }}>
                A refund has been processed for this cancelled booking. Please check your financial provider for the reflected amount.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="customer-booking-columns">

        {/* LEFT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {canAddService && (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="button" onClick={() => setAddServiceOpen(true)} variant="outline" size="sm" className="border-primary text-primary hover:text-primary uppercase">
                + Add a service
              </Button>
            </div>
          )}

          {/* ===== E. SERVICE BREAKDOWN ===== */}
          {vehicles.map((v, vIdx) => (
            <div key={v.id} style={cardStyle}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--admin-border)', paddingBottom: '1rem', marginBottom: '1rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'var(--admin-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--admin-border)' }}>
                    <Car size={22} color="var(--admin-brand)" />
                  </div>
                  <div>
                    <h4 style={{ margin: 0, fontWeight: '950', fontSize: '1.1rem', color: 'var(--admin-text-primary)' }}>{v.brand} {v.model}</h4>
                    <span style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>{v.plate_number} · {v.vehicle_type}</span>
                  </div>
                </div>
                <div style={{
                  fontSize: '0.65rem', fontWeight: '950', padding: '0.3rem 0.6rem', borderRadius: '4px', textTransform: 'uppercase',
                  background: v.status === 'completed' ? 'rgba(16,185,129,0.1)' : v.status === 'in_progress' ? 'rgba(168,85,247,0.1)' : v.status === 'QUEUED' ? 'rgba(245,158,11,0.1)' : 'var(--admin-input-bg)',
                  color: v.status === 'completed' ? '#10b981' : v.status === 'in_progress' ? '#a855f7' : v.status === 'QUEUED' ? '#f59e0b' : 'var(--admin-text-secondary)',
                  border: '1px solid currentColor'
                }}>
                  {v.status === 'QUEUED' ? 'QUEUED' : (v.status || 'pending').toUpperCase()}
                </div>
              </div>

              {/* Service Rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {(v.services || []).map(s => (
                  <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem', background: 'var(--admin-bg)', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Package size={14} color="var(--admin-brand)" />
                      <span style={{ fontSize: '0.9rem', fontWeight: '800', color: 'var(--admin-text-primary)' }}>{s.service_name || s.service_name_snapshot}</span>
                    </div>
                    <span style={{ fontSize: '0.95rem', fontWeight: '950', color: 'var(--admin-brand)' }}>₱{resolveFrozenServicePrice(s).toLocaleString()}</span>
                  </div>
                ))}
              </div>
              {/* Vehicle Subtotal */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px dashed var(--admin-border)' }}>
                <span style={{ fontSize: '1.1rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>
                  Vehicle Total: ₱{(v.subtotal || (v.services || []).reduce((sum, s) => sum + resolveFrozenServicePrice(s), 0)).toLocaleString()}
                </span>
              </div>

              {/* Service photos and staff notes */}
              <div style={{ marginTop: '1.25rem', paddingTop: '1.25rem', borderTop: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div style={{ display: 'flex', gap: '1.5rem' }}>
                  <div>
                    <div style={labelStyle}>Service Started</div>
                    <div style={v.started_at ? valStyle : { ...valStyle, opacity: 0.2 }}>
                      {v.started_at ? new Date(v.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '---'}
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>Service Finished</div>
                    <div style={v.completed_at ? { ...valStyle, color: 'var(--admin-success)' } : { ...valStyle, opacity: 0.2 }}>
                      {v.completed_at ? new Date(v.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '---'}
                    </div>
                  </div>
                </div>

                {/* Batch 5: always render so photos stored only in service_photos are reachable. */}
                {true && (
                  <div style={{ display: 'flex', gap: '1.5rem' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flexShrink: 0 }}>
                      <Button type="button" onClick={() => {
                          setPhotoGalleryVehicleId(v.id);
                          setPhotoGalleryOpen(true);
                        }} variant="outline" size="sm" className="border-primary text-primary hover:text-primary uppercase">
                        View Service Photos
                      </Button>
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ ...labelStyle, color: 'var(--admin-brand)', marginBottom: '0.4rem' }}>Staff Notes</div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--admin-text-secondary)', fontWeight: '600', fontStyle: 'italic', lineHeight: 1.5 }}>
                        "{v.service_notes || 'No detailing notes provided by technician.'}"
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* ===== B. PAYMENT PANEL ===== */}
          {false && <div style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '0.9rem', fontWeight: '950', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--admin-text-primary)' }}>
                <CreditCard size={18} /> Payment History
              </h3>
              <div style={{ fontSize: '1.5rem', fontWeight: '950', color: 'var(--admin-brand)' }}>₱{(booking.total_amount || 0).toLocaleString()}</div>
            </div>

            {payments.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: '600', background: 'var(--admin-bg)', borderRadius: 'var(--admin-radius-md)', border: '1px dashed var(--admin-border)' }}>
                No payments recorded yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {payments.map((p, idx) => (
                  <div key={p.id} style={{ background: 'var(--admin-bg)', borderRadius: 'var(--admin-radius-md)', border: '1px solid var(--admin-border)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', gap: '1rem', padding: '1rem' }}>
                      {p.receipt_url && (
                        <div style={{ width: '70px', height: '70px', borderRadius: 'var(--admin-radius-sm)', overflow: 'hidden', flexShrink: 0, border: '1px solid var(--admin-border)' }}>
                          <img src={p.receipt_url} alt="Receipt" style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' }} onClick={() => openImage(p.receipt_url, { alt: 'Proof of payment' })} />
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                          <div>
                            <div style={{ fontWeight: '900', fontSize: '0.85rem', color: p.status === 'REFUNDED' ? '#ef4444' : 'var(--admin-text-primary)' }}>
                              {p.status === 'REFUNDED' ? 'REFUND RECORD' : 'PAYMENT'} #{idx + 1} • {p.method}
                            </div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: '800' }}>{new Date(p.created_at).toLocaleString()}</div>
                          </div>
                          <div style={{
                            fontSize: '0.6rem', fontWeight: '950', padding: '0.2rem 0.5rem', borderRadius: '4px',
                            background: p.status === 'PAID' ? 'rgba(16,185,129,0.1)' : p.status === 'REJECTED' || p.status === 'REFUNDED' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                            color: p.status === 'PAID' ? '#10b981' : p.status === 'REJECTED' || p.status === 'REFUNDED' ? '#ef4444' : '#f59e0b',
                            border: '1px solid currentColor'
                          }}>
                            {p.status}
                          </div>
                        </div>
                        <div style={{ fontWeight: '950', fontSize: '1.1rem', marginTop: '0.25rem', color: p.status === 'REFUNDED' ? '#ef4444' : 'var(--admin-text-primary)' }}>
                          {p.amount < 0 ? '-' : ''}₱{Math.abs(p.amount || 0).toLocaleString()}
                        </div>
                        {p.status === 'REJECTED' && p.rejection_reason && (
                          <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', fontWeight: '700', color: 'var(--status-danger)', background: 'rgba(239,68,68,0.05)', padding: '0.5rem', borderRadius: '4px' }}>
                            <AlertCircle size={12} style={{ marginRight: '0.25rem', verticalAlign: 'middle' }} /> {p.rejection_reason}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Balance Bar */}
            <div style={{
              marginTop: '1.5rem', padding: '1rem', borderRadius: 'var(--admin-radius-md)', textAlign: 'center', fontWeight: '950', fontSize: '0.9rem',
              background: balance === 0 ? 'rgba(16,185,129,0.05)' : 'rgba(245,158,11,0.05)',
              color: balance === 0 ? '#10b981' : '#f59e0b',
              border: `1px solid ${balance === 0 ? '#10b981' : '#f59e0b'}`
            }}>
              {balance === 0 ? 'FULLY SETTLED' : `OUTSTANDING BALANCE: ₱${balance.toLocaleString()}`}
            </div>
            {canPayBalance && (
              <Button type="button" onClick={() => setPayBalanceOpen(true)} className="mt-3 w-full uppercase">
                Pay remaining balance ({formatCurrency(payableBalance)})
              </Button>
            )}
            {balance > 0 && payableBalance <= 0 && awaitingVerification > 0 && (
              <p role="status" style={{ margin: '0.75rem 0 0', textAlign: 'center', fontSize: '0.75rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>
                Your payment of {formatCurrency(awaitingVerification)} is waiting for the shop to verify.
              </p>
            )}
          </div>}
        </div>

        {/* RIGHT COLUMN */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

          {/* ===== D. RECEIPT SECTION — Appointment Info ===== */}
          {false && <div style={cardStyle}>
            <div style={labelStyle}>Appointment Details</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Date</span>
                <span style={valStyle}>{dateStr}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Time</span>
                <span style={valStyle}>{timeStr}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Status</span>
                <span style={{ ...valStyle, color: getStatusColor(derivedStatus), textTransform: 'uppercase' }}>{derivedStatus}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Vehicles</span>
                <span style={valStyle}>{vehicles.length}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ ...labelStyle, marginBottom: 0 }}>Total</span>
                <span style={{ ...valStyle, color: 'var(--admin-brand)' }}>₱{(booking.total_amount || 0).toLocaleString()}</span>
              </div>
            </div>
          </div>}

          {/* ===== B. BILLING & TRANSACTIONS ===== */}
          <div style={cardStyle}>
            <div className={balance > 0 ? 'billing-balance-grid' : undefined}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '0.8rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>Billing & Transactions</h3>
              <CreditCard size={18} color="var(--admin-brand)" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {payments.length === 0 ? (
                <div style={{ fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontStyle: 'italic' }}>No transactions recorded yet.</div>
              ) : payments.map(p => (
                <div key={p.id} style={{ background: 'var(--admin-bg)', padding: '1rem', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase' }}>{['GCASH', 'DIGITAL'].includes(String(p.method || '').toUpperCase()) ? 'DIGITAL PAYMENT' : (p.method || 'Online Payment')}</span>
                    <span style={{ fontSize: '0.9rem', fontWeight: '950', color: p.status === 'PAID' ? 'var(--admin-success)' : 'var(--admin-warning)' }}>{formatCurrency(p.amount)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.65rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>{new Date(p.created_at).toLocaleDateString()}</span>
                    <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {p.receipt_url && ['GCASH', 'DIGITAL'].includes(String(p.method || '').toUpperCase()) && (
                      <Button type="button" onClick={() => openImage(p.receipt_url, { alt: 'Proof of payment' })} variant="outline" size="sm">
                        VIEW PROOF OF PAYMENT
                      </Button>
                    )}
                    {p.status === 'PAID' && (
                      <Button onClick={() => { setSelectedPayment(p); setReceiptModal(true); }} variant="outline" size="sm" className="border-primary text-primary hover:text-primary">
                        <Printer size={12} /> RECEIPT
                      </Button>
                    )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px dashed var(--admin-border)', display: 'grid', gap: '0.65rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)' }}>Booking Total</span>
                <span style={{ fontSize: '0.78rem', fontWeight: '900' }}>{formatCurrency(booking.total_amount || 0)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)' }}>Applied to Booking</span>
                <span style={{ fontSize: '0.78rem', fontWeight: '900' }}>{formatCurrency(appliedToBooking)}</span>
              </div>
              {excessCredit > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--admin-text-secondary)' }}>Excess Credit</span>
                <span style={{ fontSize: '0.78rem', fontWeight: '950', color: 'var(--admin-success)' }}>{formatCurrency(excessCredit)}</span>
              </div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', paddingTop: '0.65rem', borderTop: '1px dashed var(--admin-border)' }}>
              <span style={{ fontSize: '0.8rem', fontWeight: '950', color: 'var(--admin-text-primary)' }}>BALANCE REMAINING</span>
                <span style={{ fontSize: '1rem', fontWeight: '950', color: 'var(--admin-warning)' }}>{formatCurrency(balance)}</span>
              </div>
            </div>
          </div>
          {balance > 0 && (
            <div>
              <div style={labelStyle}>Outstanding Balance</div>
              <div style={{ fontSize: '1.8rem', fontWeight: '950', color: 'var(--admin-warning)', margin: '.35rem 0 1rem' }}>{formatCurrency(balance)}</div>
              {canPayBalance ? (
                <>
                  <div style={{ fontSize: '.75rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5, marginBottom: '.75rem' }}>Pay the rest, then upload your receipt so the shop can verify it.</div>
                  <Button type="button" onClick={() => setPayBalanceOpen(true)} className="w-full uppercase">
                    Pay remaining balance
                  </Button>
                </>
              ) : (
                <div style={{ fontSize: '.75rem', color: 'var(--admin-text-secondary)', lineHeight: 1.5 }}>
                  {awaitingVerification > 0 ? 'Your payment is waiting for the shop to verify.' : 'This booking can no longer take payments.'}
                </div>
              )}
            </div>
          )}
          </div>
          </div>

          {/* ===== ACTIONS ===== */}
          {canCancelBooking && (
            <div style={{ ...cardStyle, border: '1px solid rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.02)' }}>
              <div style={{ ...labelStyle, color: 'var(--status-danger)' }}>Danger Zone</div>
              <p style={{ margin: '0.5rem 0 1rem 0', fontSize: '0.8rem', color: 'var(--admin-text-secondary)', fontWeight: '600' }}>
                You may cancel before service starts. Any eligible payment will be queued in the Refund Hub for review.
              </p>
              <Button onClick={() => setShowCancelModal(true)} variant="outline" className="border-destructive/60 text-destructive hover:text-destructive w-full uppercase">
                Cancel Appointment
              </Button>
              <Button onClick={openRescheduleModal} variant="outline" className="border-primary text-primary hover:text-primary w-full mt-3 uppercase">
                Reschedule Appointment
              </Button>
            </div>
          )}

          <Dialog open={showRescheduleModal} onOpenChange={setShowRescheduleModal}>
            <DialogContent className="ui-root max-h-[92dvh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>Reschedule Appointment</DialogTitle>
                <DialogDescription>Your payment is preserved. The current staff and bay allocation will be released and the booking will return to Scheduled.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-1.5">
                <Label>New Date</Label>
                <CustomCalendar selectedDate={rescheduleDate} onDateSelect={setRescheduleDate} />
              </div>
              <p className="rounded-md border px-3 py-2 text-xs font-semibold text-muted-foreground">
                Working hours: {businessHours ? `${businessHours.opening} - ${businessHours.closing}` : 'Loading...'}
              </p>
              <div className="grid gap-1.5">
                <Label>Available Time Slots</Label>
                {rescheduleSlotsLoading ? (
                  <div className="grid grid-cols-3 gap-2" aria-busy="true">
                    <Skeleton className="h-12" /><Skeleton className="h-12" /><Skeleton className="h-12" />
                  </div>
                ) : rescheduleSlots.length === 0 ? (
                  <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs font-semibold text-destructive">No available slots for this date. Choose another date.</p>
                ) : (
                  <div className="grid max-h-[28dvh] grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2 overflow-y-auto pr-1">
                    {rescheduleSlots.map(slot => (
                      <Button key={slot.time} type="button" variant={rescheduleTime === slot.time ? 'default' : 'outline'} onClick={() => setRescheduleTime(slot.time)} className="h-auto flex-col gap-0 py-2">
                        {slot.time}
                        <small className="text-[0.65rem] font-normal opacity-75">{slot.availableBays} bay{slot.availableBays === 1 ? '' : 's'} open</small>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowRescheduleModal(false)}>Go back</Button>
                <Button type="button" onClick={confirmReschedule} disabled={!rescheduleDate || !selectedRescheduleSlot || isRescheduling} title={!selectedRescheduleSlot ? 'Select an available time slot first' : 'Confirm reschedule'}>{isRescheduling ? 'Processing...' : selectedRescheduleSlot ? 'Confirm' : 'Select a time'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Batch 7 / Step 7.3: reschedule schedule-conflicts surface here as a
              guided decision (pick another time/date) rather than a toast. */}
          <ValidationModal
            open={Boolean(rescheduleIssue)}
            code={rescheduleIssue?.code}
            message={rescheduleIssue?.message}
            details={{ date: rescheduleIssue?.date, time: rescheduleIssue?.time }}
            onClose={() => setRescheduleIssue(null)}
            onPickAnotherTime={() => setRescheduleIssue(null)}
            onSelectNextAvailable={() => {
              setRescheduleIssue(null);
              setRescheduleDate('');
              setRescheduleTime('');
            }}
          />

          {/* CANCELLATION */}
          <Dialog open={showCancelModal} onOpenChange={setShowCancelModal}>
            <DialogContent className="ui-root sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-destructive"><AlertCircle className="size-5" aria-hidden="true" />Confirm Cancellation?</DialogTitle>
                <DialogDescription>
                  Please provide a reason for cancelling this appointment.
                  {booking.totalPaid > 0 && " A refund request will be initiated automatically."}
                </DialogDescription>
              </DialogHeader>
              <Textarea
                placeholder="e.g. Change of plans / Conflict in schedule..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="min-h-24 resize-none"
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowCancelModal(false)}>Go back</Button>
                <Button type="button" variant="destructive" disabled={!cancelReason.trim() || isCancelling} onClick={confirmCancellation}>{isCancelling ? 'Processing...' : 'Confirm'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

        </div>
      </div>
      {receiptModal && (
        <OfficialReceipt
          booking={booking}
          vehicles={vehicles}
          user={user}
          selectedPayment={selectedPayment}
          onClose={() => { setReceiptModal(false); setSelectedPayment(null); }}
          mode="modal"
        />
      )}

      {/* Batch 5: customer photo evidence drawer (RLS scopes to their booking). */}
      <PhotoProofGallery
        bookingId={booking?.id || id}
        bookingVehicleId={photoGalleryVehicleId}
        open={photoGalleryOpen}
        onClose={() => {
          setPhotoGalleryOpen(false);
          setPhotoGalleryVehicleId(null);
        }}
      />

      <AddServiceDialog
        open={addServiceOpen}
        onOpenChange={setAddServiceOpen}
        booking={booking}
        vehicles={addableVehicles}
        ledger={booking.ledger}
        onAdded={() => fetchAll()}
      />

      <PaymentProofModal
        open={payBalanceOpen}
        onOpenChange={setPayBalanceOpen}
        bookingId={booking.id}
        amountDue={payableBalance}
        onSubmitted={() => fetchAll()}
      />

      <style>{`
        @media print {
          body * { visibility: hidden; }
          #printable-receipt, #printable-receipt * { visibility: visible; }
          #printable-receipt { position: absolute; left: 0; top: 0; width: 100%; background: #fff !important; color: #000 !important; }
          .no-print, .header-close-button, .action-buttons-container, .modal-overlay > *:not(.no-print-bg) { display: none !important; }
          .no-print-bg { border-radius: 0 !important; box-shadow: none !important; max-height: unset !important; }
          .price-column { font-variant-numeric: tabular-nums; text-align: right; }
          .invoice-content { page-break-inside: avoid; }
        }
      `}</style>
      </div>
    </>
  );
};

export default CustomerBookingDetails;
