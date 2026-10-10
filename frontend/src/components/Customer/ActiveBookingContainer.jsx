import React from 'react';
import { Clock, User, FileText, ChevronRight, Car, CalendarOff, Wallet } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { describeLedgerState } from '../../services/bookingService';
import { Button } from '@/components/ui/button';

const peso = (value) => `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const STATUS_COLOR = {
  scheduled: 'var(--admin-brand)',
  confirmed: 'var(--admin-info)',
  in_progress: '#a855f7',
  ongoing: '#a855f7',
  completed: 'var(--admin-success)'
};

const TONE_COLOR = {
  success: 'var(--admin-success)',
  pending: 'var(--admin-warning)',
  warning: 'var(--admin-warning)',
  danger: 'var(--admin-brand)',
  neutral: 'var(--admin-text-secondary)'
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const label = { fontSize: '0.7rem', fontWeight: 950, color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '1px' };
const box = { padding: '1rem', background: 'var(--admin-bg)', borderRadius: 'var(--admin-radius-md)', border: '1px solid var(--admin-border)' };

const ActiveBookingContainer = ({ booking, loading }) => {
  const navigate = useNavigate();

  const cardStyle = {
    background: 'var(--admin-card)',
    borderRadius: 'var(--admin-radius-lg)',
    border: '1px solid var(--admin-border)',
    overflow: 'hidden',
    boxShadow: 'var(--admin-card-shadow)'
  };

  if (loading) {
    return <div style={{ ...cardStyle, padding: '3rem', textAlign: 'center', color: 'var(--admin-brand)', fontWeight: 900 }}>Loading active booking...</div>;
  }

  if (!booking) {
    return (
      <div style={{ ...cardStyle, padding: '3rem', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
        <CalendarOff size={48} color="var(--admin-text-secondary)" style={{ opacity: 0.3 }} />
        <div style={{ color: 'var(--admin-text-primary)', fontWeight: 900, fontSize: '1.1rem' }}>No Active Booking</div>
        <div style={{ color: 'var(--admin-text-secondary)', fontSize: '0.85rem', fontWeight: 600 }}>You don't have any ongoing or scheduled appointments right now.</div>
        <Button onClick={() => navigate('/customer/book')} variant="default" className="mt-2">
          + Book Appointment
        </Button>
      </div>
    );
  }

  const vehicles = booking.vehicles || [];
  const statuses = vehicles.map((v) => String(v.status || '').toUpperCase());
  const finished = statuses.filter((s) => s === 'COMPLETED').length;
  const started = statuses.includes('IN_PROGRESS');
  const allFinished = statuses.length > 0 && statuses.every((s) => s === 'COMPLETED' || s === 'CANCELLED');

  let status = String(booking.status || 'scheduled').toLowerCase();
  if (started && ['scheduled', 'confirmed'].includes(status)) status = 'in_progress';
  if (allFinished && status !== 'cancelled') status = 'completed';
  const color = STATUS_COLOR[status] || 'var(--admin-text-secondary)';

  const start = booking.start_datetime ? new Date(booking.start_datetime) : null;
  const when = start
    ? `${start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : 'To be scheduled';
  const serviceCount = vehicles.reduce((sum, v) => sum + (v.services?.length || 0), 0);

  // money: always from the booking's ledger
  const ledger = booking.ledger || null;
  const state = describeLedgerState(ledger);
  const total = Number(ledger?.expected_amount ?? ledger?.original_amount ?? booking.total_amount ?? 0);
  const paid = Number(ledger?.net_settled ?? booking.totalPaid ?? 0);
  const balance = Number(ledger?.outstanding_amount ?? Math.max(0, total - paid));
  const overpaid = Number(ledger?.excess_amount || 0);

  const technicianNames = booking.technician_names || [];
  const unassigned = vehicles.filter((v) => !v.technician_name).length;
  const technicianText = technicianNames.length ? technicianNames.join(', ') : 'Not assigned yet';
  const technicianNote = technicianNames.length === 0
    ? 'The shop will assign a technician soon'
    : unassigned > 0 ? `${unassigned} vehicle${unassigned === 1 ? '' : 's'} still waiting` : 'All vehicles assigned';

  return (
    <div style={cardStyle}>
      <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
        <div style={{ minWidth: 0 }}>
          <div style={label}>Your current booking</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0.3rem 0' }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 950, textTransform: 'uppercase', color: 'var(--admin-text-primary)' }}>{status.replace(/_/g, ' ')}</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>
            <Clock size={14} color="var(--admin-text-secondary)" /> {when}
          </div>
          {booking.updated_at && <div style={{ marginTop: '0.2rem', fontSize: '0.72rem', fontWeight: 600, color: 'var(--admin-text-secondary)' }}>Updated {timeAgo(booking.updated_at)}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={label}>Ref no.</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 900, fontFamily: 'monospace', color: 'var(--admin-text-primary)' }}>#{booking.id?.substring(0, 8).toUpperCase()}</div>
        </div>
      </div>

      <div style={{ padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div style={box}>
            <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem' }}><Wallet size={13} /> Payment</div>
            <div style={{ fontSize: '0.9rem', fontWeight: 950, textTransform: 'uppercase', color: TONE_COLOR[state.tone] || 'var(--admin-text-primary)', marginBottom: '0.5rem' }}>{state.label}</div>
            {[['Total', peso(total)], ['Paid', peso(paid)], ['Balance', peso(balance)]].map(([name, value]) => (
              <div key={name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.2rem' }}>
                <span style={{ color: 'var(--admin-text-secondary)', fontWeight: 600 }}>{name}</span>
                <span style={{ fontWeight: 800, color: name === 'Balance' && balance > 0 ? 'var(--admin-warning)' : 'var(--admin-text-primary)' }}>{value}</span>
              </div>
            ))}
            {overpaid > 0.009 && <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--admin-text-secondary)' }}>Overpaid by {peso(overpaid)}</div>}
          </div>

          <div style={box}>
            <div style={{ ...label, display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem' }}><User size={13} /> Technician</div>
            <div style={{ fontSize: '0.95rem', fontWeight: 900, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>{technicianText}</div>
            <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--admin-text-secondary)', marginTop: '0.25rem' }}>{technicianNote}</div>
            {vehicles.length > 0 && (
              <div style={{ marginTop: '0.6rem', fontSize: '0.75rem', fontWeight: 700, color: 'var(--admin-text-secondary)' }}>
                {finished} of {vehicles.length} vehicle{vehicles.length === 1 ? '' : 's'} finished · {serviceCount} service{serviceCount === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>

        <div>
          <div style={{ ...label, marginBottom: '0.6rem' }}>Vehicles and services</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: '0.75rem' }}>
            {vehicles.map((vehicle) => (
              <div key={vehicle.id} style={box}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.6rem' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--admin-text-primary)', overflowWrap: 'anywhere' }}>{[vehicle.brand, vehicle.model].filter(Boolean).join(' ') || 'Vehicle'}</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 800, color: 'var(--admin-text-secondary)', marginTop: '0.15rem' }}>
                      {[vehicle.vehicle_type, vehicle.plate_number].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span style={{ fontSize: '0.65rem', fontWeight: 900, textTransform: 'uppercase', color: String(vehicle.status).toUpperCase() === 'COMPLETED' ? 'var(--admin-success)' : String(vehicle.status).toUpperCase() === 'IN_PROGRESS' ? '#a855f7' : 'var(--admin-text-secondary)', whiteSpace: 'nowrap' }}>
                    {String(vehicle.status || 'queued').replace(/_/g, ' ')}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', fontWeight: 700, color: 'var(--admin-text-secondary)', marginBottom: '0.5rem' }}>
                  <Car size={12} /> {vehicle.technician_name ? `Technician: ${vehicle.technician_name}` : 'Technician not assigned yet'}
                </div>
                {(vehicle.services || []).length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                    {vehicle.services.map((service) => (
                      <div key={service.id || service.service_name} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', fontSize: '0.78rem', fontWeight: 700, color: 'var(--admin-text-primary)' }}>
                        <span style={{ overflowWrap: 'anywhere' }}>{service.service_name}</span>
                        <span style={{ color: 'var(--admin-text-secondary)', whiteSpace: 'nowrap' }}>{peso(service.price)}</span>
                      </div>
                    ))}
                  </div>
                ) : <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--admin-text-secondary)' }}>No services selected.</div>}
              </div>
            ))}
          </div>
        </div>

        <Button onClick={() => navigate(`/customer/bookings/${booking.id}`)} variant="default" className="w-full">
          <FileText size={16} /> View full booking <ChevronRight size={16} />
        </Button>
      </div>
    </div>
  );
};

export default ActiveBookingContainer;
