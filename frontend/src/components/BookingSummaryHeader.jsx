import React from 'react';
import { AlertTriangle, Calendar, User, Wrench, CreditCard, CheckCircle } from 'lucide-react';
import { formatBookingDate, formatBookingTime } from '../utils/bookingHelpers';
import { derivePaymentStatusBadge } from '../utils/paymentUtils';

const LIFECYCLE_STEPS = ['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'RELEASED'];

/**
 * The booking's own customer identity, in priority order:
 *   1. the linked account's profile (customer.first_name/last_name/full_name)
 *   2. the snapshot columns captured at booking time (customer_name)
 *   3. the guest details from the booking wizard (guest_name / contact)
 * Falls back to a neutral label so a walk-in is never blank.
 */
const customerName = (booking) => {
  const c = booking?.customer || {};
  const full = c.full_name
    || [c.first_name, c.last_name].filter(Boolean).join(' ').trim()
    || booking?.customer_name
    || booking?.guest_name
    || booking?.contact_name;
  return (full && String(full).trim()) || 'Walk-in Guest';
};

/** The customer's email from the profile or the booking snapshot, or '' when none. */
const customerEmail = (booking) => {
  const c = booking?.customer || {};
  const email = c.email || booking?.customer_email || booking?.guest_email || '';
  return String(email || '').trim();
};

/**
 * One row per vehicle: { vehicleId, label, name }. Pages that load the per-vehicle technicians pass
 * booking.vehicle_technicians; older callers only have the booking's single technician.
 */
const technicianRows = (booking) => Array.isArray(booking?.vehicle_technicians) ? booking.vehicle_technicians : [];

/**
 * A booking whose vehicles all have the same technician shows that name. With different technicians (or
 * an unassigned vehicle) it shows a dropdown, "Technician - Vehicle", one line per vehicle.
 */
const TechnicianSummary = ({ booking }) => {
  const rows = technicianRows(booking);
  if (rows.length === 0) return <>{booking?.assigned_staff?.full_name || 'Unassigned'}</>;
  const names = [...new Set(rows.map((row) => row.name).filter(Boolean))];
  const allAssigned = rows.every((row) => row.name);
  if (rows.length === 1 || (allAssigned && names.length === 1)) return <>{names[0] || 'Unassigned'}</>;
  return (
    <select
      aria-label="Technician for each vehicle"
      defaultValue=""
      style={{ maxWidth: '100%', padding: '0.3rem 0.4rem', background: 'var(--admin-bg)', color: 'var(--admin-text-primary)', border: '1px solid var(--admin-border)', borderRadius: '6px', fontSize: '0.8rem', fontWeight: 700 }}
    >
      <option value="" disabled>{allAssigned ? `${names.length} technicians` : 'Some vehicles unassigned'}</option>
      {rows.map((row) => <option key={row.vehicleId} value={row.vehicleId} disabled>{`${row.name || 'Unassigned'} - ${row.label}`}</option>)}
    </select>
  );
};

/** The number given at booking first, then the account's phone, or ''. */
const customerPhone = (booking) => String(booking?.contact_number || booking?.customer_phone || booking?.guest_phone || booking?.customer?.phone_number || '').trim();

const BookingSummaryHeader = ({ booking, onUnitCollected, showCustomer = true, showTechnician = true, paymentStatus }) => {
  const rawStatus = booking?.status?.toUpperCase() || 'PENDING';
  const normalizedStatus = rawStatus === 'PENDING' ? 'SCHEDULED' : rawStatus;
  const isNoShow = normalizedStatus === 'FLAGGED_NOSHOW' || normalizedStatus === 'NO_SHOW';
  const currentStepIndex = Math.max(0, LIFECYCLE_STEPS.indexOf(normalizedStatus));

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: '1.5rem',
        backgroundColor: 'var(--admin-card)', border: '1px solid var(--admin-border)',
        borderRadius: 'var(--admin-radius)', padding: '1.5rem',
        boxShadow: 'var(--admin-card-shadow)', width: '100%', marginBottom: '0.25rem', paddingBottom: '1rem'
      }}
    >
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '1.5rem', justifyContent: 'space-between',
        borderBottom: '1px solid var(--admin-border)', paddingBottom: '1.5rem'
      }}>
        <SummaryItem icon={Calendar} label="Schedule Time">
          {booking?.start_datetime ? `${formatBookingDate(booking.start_datetime)} at ${formatBookingTime(booking.start_datetime)}` : 'Unscheduled'}
        </SummaryItem>
        {showTechnician && (
          <SummaryItem icon={Wrench} label={technicianRows(booking).length > 1 ? 'Technicians' : 'Assigned Technician'}>
            <TechnicianSummary booking={booking} />
          </SummaryItem>
        )}
        {/* Customer identity, placed between the technician and the payment status.
            Shows the booking's own customer record — the linked account's name and
            email when there is one, or the guest/walk-in details captured at
            booking time. This makes "who is this for" answerable without opening
            the sidebar, and works for walk-ins that have no profile row. */}
        {showCustomer && (
          <SummaryItem icon={User} label="Customer">
            <span style={{ display: 'block' }}>
              {customerName(booking)}
            </span>
            {customerEmail(booking) && (
              <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.72rem', fontWeight: '600', color: 'var(--admin-text-secondary)' }}>
                {customerEmail(booking)}
              </span>
            )}
            {customerPhone(booking) && (
              <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.72rem', fontWeight: '600', color: 'var(--admin-text-secondary)' }}>
                {customerPhone(booking)}
              </span>
            )}
            <span style={{ display: 'block', marginTop: '0.2rem', fontSize: '0.65rem', fontWeight: '900', textTransform: 'uppercase' }}>
              <span style={{ color: booking?.customer_id ? 'var(--admin-brand)' : 'rgba(230, 30, 42, 0.62)' }}>
                {booking?.customer_id ? 'Customer Account' : (booking?.is_walk_in === false ? 'Account Deleted' : 'Walk-in Guest')}
              </span>
            </span>
          </SummaryItem>
        )}
        {paymentStatus ? (() => {
          const badge = derivePaymentStatusBadge(booking, paymentStatus);
          if (!badge) return null;
          return (
            <SummaryItem icon={CreditCard} label="Payment Status">
              <span style={{ color: badge.color, fontWeight: '900' }}>
                {badge.text}
              </span>
              {badge.subtext && (
                <span style={{ display: 'block', marginTop: '0.15rem', fontSize: '0.65rem', fontWeight: '700', color: 'var(--admin-text-secondary)' }}>
                  {badge.subtext}
                </span>
              )}
            </SummaryItem>
          );
        })() : null}
      </div>

      {isNoShow && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: '0.75rem',
            padding: '1rem', borderRadius: 'var(--admin-radius-sm)',
            color: 'var(--status-danger)', background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)'
          }}
        >
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong style={{ display: 'block', fontSize: '0.85rem', textTransform: 'uppercase' }}>Flagged no-show</strong>
            <span style={{ display: 'block', marginTop: '0.2rem', fontSize: '0.78rem', color: 'var(--admin-text-secondary)' }}>
              This appointment was marked as a no-show. Contact the shop if you need help.
            </span>
          </div>
        </div>
      )}
      {!isNoShow && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', position: 'relative', overflowX: 'auto', paddingTop: '0.5rem' }}>
          <div style={{ position: 'absolute', top: '22px', left: '8%', right: '8%', height: '2px', backgroundColor: 'var(--admin-border)', zIndex: 0 }} />
          {LIFECYCLE_STEPS.map((step, index) => {
            const isCompleted = index <= currentStepIndex;
            const isCurrent = index === currentStepIndex;
            return (
              <div key={step} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', zIndex: 1, minWidth: '80px', flex: '1 0 80px' }}>
                <div style={{ width: '24px', height: '24px', borderRadius: '50%', backgroundColor: isCompleted ? 'var(--admin-brand)' : 'var(--admin-bg)', border: `2px solid ${isCompleted ? 'var(--admin-brand)' : 'var(--admin-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-on-brand)' }}>
                  {isCompleted && <CheckCircle size={14} />}
                </div>
                <span style={{ fontSize: '0.7rem', fontWeight: isCurrent ? '700' : '400', color: isCurrent ? 'var(--admin-text-primary)' : 'var(--admin-text-secondary)', textAlign: 'center' }}>{step.replace('_', ' ')}</span>
                {step === 'COMPLETED' && rawStatus === 'COMPLETED' && onUnitCollected && (
                  <button
                    onClick={onUnitCollected}
                    style={{ marginTop: '0.4rem', padding: '0.55rem 0.9rem', background: '#059669', color: '#fff', border: '1px solid #047857', borderRadius: 'var(--admin-radius-sm)', fontSize: '0.65rem', fontWeight: '900', letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(5, 150, 105, 0.3)' }}
                  >
                    UNIT COLLECTED
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const SummaryItem = ({ icon: Icon, label, children }) => (
 <div style={{ flex: '1 1 200px', display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
    <IconBox><Icon size={20} /></IconBox>
    <div style={{ minWidth: 0, flex: '1 1 auto' }}>
      <p style={labelStyle}>{label}</p>
      <div style={{ margin: 0, fontSize: '0.95rem', fontWeight: '600', color: 'var(--admin-text-primary)', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{children}</div>
    </div>
 </div>
);

const IconBox = ({ children }) => (
  <div style={{ padding: '0.5rem', backgroundColor: 'rgba(128, 128, 128, 0.1)', borderRadius: '8px', color: 'var(--admin-brand)', flexShrink: 0 }}>{children}</div>
);

const labelStyle = { margin: 0, fontSize: '0.75rem', color: 'var(--admin-text-secondary)' };

export default BookingSummaryHeader;
