import React, { useEffect, useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  Clock, User, ChevronLeft, ChevronRight, 
  AlertCircle, LayoutGrid, Calendar, Users,
  Maximize2, ExternalLink, RefreshCcw, Search, CreditCard, RotateCw, Filter, ArrowRight
} from 'lucide-react';
import PageHeader from '../../components/PageHeader';
import LoadingState from '../../components/LoadingState';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { getPaymentStatusUI } from '../../utils/paymentUtils';
import { formatBookingDate, formatBookingTime, getStatusColor } from '../../utils/bookingHelpers';
import { useAdminBookings } from '../../hooks/useAdminBookings';
import { supabase } from '../../lib/supabase';
import { useUI } from '../../context/UIContext';
import toast from 'react-hot-toast';
import { BACKEND_URL } from '../../config/api';

import AdminSchedulingGrid from './AdminSchedulingGrid';
import { matchesSearchText } from '../../utils/searchMatch';

const AdminBookings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useMediaQuery('(max-width: 1024px)');
  const { openModal } = useUI();

  // REQ-NFR-05: Decoupled data layer via custom hook (realtime multi-table sync)
  const { bookings, loading, refresh, hasMore, loadAll } = useAdminBookings();

  // UI-only state (search, filter, view mode)
  const [state, setState] = useState({
    searchTerm: location.state?.filter || '',
    filterStatus: 'all',
    view: 'list'
  });

  useEffect(() => {
    // Check for URL filters
    const params = new URLSearchParams(location.search);
    const filter = params.get('filter');
    if (filter === 'unassigned') {
      setState(prev => ({ ...prev, filterStatus: 'unassigned' }));
    } else if (filter === 'overdue' || filter === 'FLAGGED_NOSHOW') {
      setState(prev => ({ ...prev, filterStatus: 'FLAGGED_NOSHOW' }));
    } else if (['ongoing', 'pending_payment', 'pending_refund', 'completed'].includes(filter)) {
      setState(prev => ({ ...prev, filterStatus: filter }));
    }
  }, [location.search]);

  // A search or filter has to see every booking, not just the latest page.
  useEffect(() => {
    if (hasMore && (state.searchTerm.trim() || state.filterStatus !== 'all')) loadAll();
  }, [hasMore, state.searchTerm, state.filterStatus, loadAll]);

  // MEMOIZED FILTERING: Only re-calculates when data or search changes
  const filteredBookings = useMemo(() => {
    return bookings.filter(b => {
      const matchesSearch = matchesSearchText(
        state.searchTerm, b.id, b.status, b.customer?.full_name, b.customer_name, b.guest_name,
        b.customer_email, b.contact_number,
        (b.vehicles || []).map(v => [v.vehicle_type, v.plate_number, v.brand, v.model, (v.services || []).map(s => s.service_name)])
      );
      
      let matchesStatus = state.filterStatus === 'all' || b.status?.toLowerCase() === state.filterStatus.toLowerCase();
      
      // SPECIAL FILTERS
      if (state.filterStatus === 'unassigned') {
        const bookingStatus = String(b.status || '').toLowerCase();
        const isNotAssignable = b.was_flagged_no_show
          || ['cancelled', 'completed', 'released', 'in_progress', 'ongoing', 'flagged_noshow', 'no_show'].includes(bookingStatus);
        matchesStatus = !b.staff_id && !isNotAssignable;
      } else if (state.filterStatus === 'FLAGGED_NOSHOW') {
        matchesStatus = b.status?.toUpperCase() === 'FLAGGED_NOSHOW';
      } else if (state.filterStatus === 'ongoing') {
        matchesStatus = ['scheduled', 'confirmed', 'in_progress', 'ongoing'].includes(b.status?.toLowerCase());
      } else if (state.filterStatus === 'pending_payment') {
        matchesStatus = (b.payments || []).some(payment => payment.status === 'FOR_VERIFICATION');
      } else if (state.filterStatus === 'pending_refund') {
        matchesStatus = ['PENDING', 'PROCESSING', 'REFUND_PENDING'].includes(b.refund_status) || (b.payments || []).some(payment => payment.status === 'REFUND_PENDING');
      }
      
      return matchesSearch && matchesStatus;
    });
  }, [bookings, state.searchTerm, state.filterStatus]);

  const getPaymentStatus = (booking) => {
    return getPaymentStatusUI(booking.calculatedPaymentStatus);
  };

  const submitCancellation = async (booking, reason) => {
    const toastId = toast.loading('Cancelling booking and queuing refunds...');
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 30000);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Your admin session has expired. Sign in again before cancelling this booking.');
      }
      const response = await fetch(`${BACKEND_URL}/api/bookings/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token || ''}`
        },
        body: JSON.stringify({ bookingId: booking.id, reason }),
        signal: controller.signal
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Cancellation failed (HTTP ${response.status}).`);
      }
      toast.success('Booking cancelled; eligible payments are in the Refund Hub.', { id: toastId });
      (result.warnings || []).forEach((warning) => toast.error(warning));
      await refresh();
    } catch (error) {
      const requestTimedOut = error.name === 'AbortError';
      const isNetworkError = error instanceof TypeError;
      if (requestTimedOut || isNetworkError) {
        try {
          const { data: currentBooking, error: statusError } = await supabase
            .from('bookings')
            .select('status')
            .eq('id', booking.id)
            .maybeSingle();
          if (statusError) throw statusError;
          if (String(currentBooking?.status || '').toUpperCase() === 'CANCELLED') {
            toast.success('Booking was cancelled. The request response was delayed; the booking status is confirmed.', { id: toastId });
            await refresh();
            return;
          }
        } catch (statusError) {
          toast.error(`Could not confirm cancellation status: ${statusError.message || 'status lookup failed'}`, { id: toastId });
          return;
        }
      }
      const message = requestTimedOut
        ? 'Cancellation timed out after 30 seconds. The booking is not confirmed as cancelled; refresh and check before retrying.'
        : isNetworkError
          ? `Could not reach the booking service at ${BACKEND_URL || 'this site'}. Check the backend connection and try again.`
          : error.message || 'Cancellation failed.';
      toast.error(message, { id: toastId });
    } finally {
      window.clearTimeout(timeoutId);
    }
  };

  const requestCancelBooking = (booking) => {
    openModal({
      title: 'Cancel this booking?',
      message: 'This will stop the booking, queue eligible payments for refund review, and email the customer.',
      confirmText: 'Continue',
      cancelText: 'Keep Booking',
      type: 'danger',
      onConfirm: () => openModal({
        title: 'Cancellation reason',
        message: 'Enter the reason. It will be saved to the booking audit trail.',
        type: 'danger',
        prompt: true,
        inputLabel: 'Reason',
        inputPlaceholder: 'Customer request, operational issue, etc.',
        confirmText: 'Cancel Booking',
        cancelText: 'Keep Booking',
        onConfirm: (reason) => {
          if (!String(reason || '').trim()) {
            toast.error('A cancellation reason is required.');
            return;
          }
          void submitCancellation(booking, String(reason).trim());
        }
      })
    });
  };

  const canCancel = (booking) => {
    const status = String(booking.status || '').toLowerCase();
    const vehicleStatuses = (booking.vehicles || []).map((vehicle) =>
      String(vehicle.status || '').toUpperCase()
    );

    return !['in_progress', 'ongoing', 'completed', 'released', 'cancelled'].includes(status)
      && !vehicleStatuses.some((vehicleStatus) =>
        ['IN_PROGRESS', 'ONGOING', 'COMPLETED', 'RELEASED'].includes(vehicleStatus)
      );
  };

  const containerStyle = {
    background: 'var(--admin-card)',
    borderRadius: 'var(--admin-radius)',
    overflow: 'hidden',
    boxShadow: 'var(--admin-card-shadow)',
    color: 'var(--admin-text-primary)',
    border: '1px solid var(--admin-border)'
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      
      <PageHeader 
        badge="RECORDS MANAGEMENT"
        title="BOOKING DIRECTORY"
        subtitle="Manage and monitor all vehicle detailing appointments."
        onRefresh={refresh}
        actionLabel={state.view === 'list' ? "SWITCH TO GRID VIEW" : "SWITCH TO LIST VIEW"}
        onAction={() => setState(prev => ({ ...prev, view: prev.view === 'list' ? 'grid' : 'list' }))}
        actionIcon={state.view === 'list' ? <LayoutGrid size={18} /> : <RotateCw size={18} />}
      />

      {state.view === 'grid' ? (
        <AdminSchedulingGrid onBack={() => setState(prev => ({ ...prev, view: 'list' }))} />
      ) : (
        <>

      <div style={{ background: 'var(--admin-card)', borderRadius: 'var(--admin-radius)', overflow: 'hidden', border: '1px solid var(--admin-border)', padding: '1rem' }}>
        <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: '0.75rem' }}>
          <div style={{ position: 'relative', background: 'var(--admin-bg)', padding: '0.85rem 1.25rem', borderRadius: 'var(--admin-radius-sm)', flex: 1, border: '1px solid var(--admin-border)', display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <Search size={18} color="var(--admin-text-secondary)" style={{ flexShrink: 0 }} />
            <input 
              type="text"
              placeholder="Search by customer, vehicle, plate..." 
              value={state.searchTerm}
              onChange={(e) => setState(prev => ({ ...prev, searchTerm: e.target.value }))}
              style={{ border: 'none', background: 'transparent', color: 'var(--admin-text-primary)', width: '100%', outline: 'none', fontSize: '0.9rem', fontWeight: '700', textTransform: 'uppercase' }} 
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', background: 'var(--admin-bg)', padding: '0.4rem', borderRadius: 'var(--admin-radius-sm)', border: '1px solid var(--admin-border)', overflowX: 'auto' }}>
            {['all', 'unassigned', 'FLAGGED_NOSHOW', 'scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled'].map(f => (
              <button 
                key={f}
                onClick={() => setState(prev => ({ ...prev, filterStatus: f }))}
                style={{ 
                  padding: '0.5rem 0.85rem', borderRadius: '6px', border: 'none',
                  background: state.filterStatus === f ? 'var(--admin-brand)' : 'transparent',
                  color: state.filterStatus === f ? 'var(--admin-text-on-brand)' : 'var(--admin-text-secondary)',
                  fontSize: '0.65rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase',
                  whiteSpace: 'nowrap'
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      {hasMore && !loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', padding: '0.75rem 1rem', marginBottom: '1rem', border: '1px solid var(--admin-border)', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 800, color: 'var(--admin-text-secondary)' }}>
          <span>Showing the {bookings.length} most recent bookings.</span>
          <button type="button" onClick={loadAll} style={{ padding: '0.4rem 0.9rem', borderRadius: '6px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'var(--admin-text-primary)', fontWeight: 900, fontSize: '0.7rem', cursor: 'pointer', textTransform: 'uppercase' }}>Load all bookings</button>
        </div>
      )}

      {loading ? (
        <LoadingState message="Retrieving booking records..." />
      ) : filteredBookings.length === 0 ? (
        <div style={{ ...containerStyle, padding: '4rem', textAlign: 'center', color: 'var(--admin-text-secondary)', fontSize: '0.8rem', fontWeight: '900', textTransform: 'uppercase' }}>No matching records found</div>
      ) : isMobile ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {filteredBookings.map(booking => {
            const pStatus = getPaymentStatus(booking);
            return (
              <div 
                key={booking.id}
                onClick={() => navigate(`/admin/bookings/${booking.id}`)}
                style={{ ...containerStyle, padding: '1.25rem', position: 'relative', cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
                  <div>
                    <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '950', fontSize: '0.65rem', letterSpacing: '0.5px' }}>#{booking.id.substring(0, 8).toUpperCase()}</span>
                    <h3 style={{ margin: '0.25rem 0 0 0', fontSize: '1rem', fontWeight: '950', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>{booking.customer_name || booking.customer?.full_name || 'Unknown'}</h3>
                  </div>
                  <div style={{
                    background: 'var(--admin-bg)', color: getStatusColor(booking.status), padding: '0.4rem 0.8rem',
                    borderRadius: 'var(--admin-radius-sm)', fontSize: '0.65rem', fontWeight: '950',
                    border: '1px solid currentColor', textTransform: 'uppercase'
                  }}>
                    {booking.status?.toUpperCase()}
                  </div>
                </div>

                <div className="booking-directory-card-meta" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', padding: '1rem 0', borderTop: '1px solid var(--admin-border)', borderBottom: '1px solid var(--admin-border)' }}>
                  <div>
                    <p style={{ margin: 0, fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Vehicle</p>
                    <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', fontWeight: '800', color: 'var(--admin-text-primary)', textTransform: 'uppercase' }}>
                      {booking.vehicles?.length > 1 ? `FLEET (${booking.vehicles.length})` : (booking.vehicles?.[0]?.vehicle_type || 'N/A')}
                    </p>
                  </div>
                  <div>
                    <p style={{ margin: 0, fontSize: '0.6rem', fontWeight: '950', color: 'var(--admin-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Date</p>
                    <p style={{ margin: '0.2rem 0 0 0', fontSize: '0.8rem', fontWeight: '800', color: 'var(--admin-text-primary)' }}>{formatBookingDate(booking.start_datetime)}</p>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
                   <div style={{ color: pStatus.color, fontSize: '0.7rem', fontWeight: '950', textTransform: 'uppercase', background: 'rgba(255,255,255,0.02)', padding: '0.4rem 0.75rem', borderRadius: 'var(--admin-radius-sm)', border: `1px solid ${pStatus.color}40` }}>
                     ₱{(booking.total_amount || 0).toLocaleString()} • {pStatus.label}
                   </div>
                   <ArrowRight size={16} style={{ color: 'var(--admin-text-secondary)', opacity: 0.3 }} />
                </div>
                {canCancel(booking) && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      requestCancelBooking(booking);
                    }}
                    style={{ width: '100%', marginTop: '0.85rem', padding: '0.75rem', background: 'transparent', border: '1px solid var(--status-danger, #dc2626)', borderRadius: 'var(--admin-radius-sm)', color: 'var(--status-danger, #dc2626)', fontSize: '0.7rem', fontWeight: 900, cursor: 'pointer', textTransform: 'uppercase' }}
                  >
                    Cancel
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="table-responsive-container" style={containerStyle}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--admin-border)', background: 'var(--admin-sidebar)' }}>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Record</th>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Customer</th>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Vehicle</th>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Schedule</th>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}>Total Amount</th>
                <th style={{ padding: '1.25rem 1.5rem', color: 'var(--admin-text-secondary)', fontSize: '0.65rem', fontWeight: '950', textTransform: 'uppercase', letterSpacing: '1.5px' }}></th>
              </tr>
            </thead>
            <tbody>
              {filteredBookings.map(booking => {
                const pStatus = getPaymentStatus(booking);
                return (
                  <tr key={booking.id} style={{ borderBottom: '1px solid var(--admin-border)', transition: 'background 0.2s' }}>
                    <td style={{ padding: '1.25rem 1.5rem' }}>
                      <span style={{ color: 'var(--admin-text-secondary)', fontWeight: '950', fontSize: '0.7rem' }}>
                        #{booking.id.substring(0, 6).toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: '1.25rem 1.5rem' }}>
                      <span style={{ fontWeight: '950', color: 'var(--admin-text-primary)', fontSize: '0.85rem', textTransform: 'uppercase' }}>{booking.customer_name || booking.customer?.full_name || 'Unknown'}</span>
                    </td>
                     <td style={{ padding: '1.25rem 1.5rem' }}>
                      <div style={{ fontWeight: '800', color: 'var(--admin-text-primary)', fontSize: '0.8rem', textTransform: 'uppercase' }}>
                        {booking.vehicles?.length > 1 ? `FLEET (${booking.vehicles.length} UNITS)` : (booking.vehicles?.[0]?.vehicle_type || 'N/A')}
                      </div>
                    </td>
                     <td style={{ padding: '1.25rem 1.5rem' }}>
                      <div style={{ fontWeight: '800', color: 'var(--admin-text-primary)', fontSize: '0.8rem' }}>{formatBookingDate(booking.start_datetime)}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--admin-text-secondary)', fontWeight: '700' }}>{formatBookingTime(booking.start_datetime)}</div>
                    </td>
                    <td style={{ padding: '1.25rem 1.5rem' }}>
                      <div style={{ fontWeight: '950', color: 'var(--admin-brand)', fontSize: '1rem', fontFamily: 'monospace' }}>
                        ₱{(booking.total_amount || 0).toLocaleString()}
                      </div>
                      <div style={{ fontSize: '0.55rem', fontWeight: '950', color: pStatus.color }}>{pStatus.label}</div>
                    </td>
                    <td style={{ padding: '1.25rem 1.5rem', textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={() => navigate(`/admin/bookings/${booking.id}`)}
                          style={{
                            background: 'var(--admin-bg)', border: '1px solid var(--admin-border)',
                            color: 'var(--admin-text-primary)', padding: '0.6rem 1rem', borderRadius: 'var(--admin-radius-sm)',
                            fontSize: '0.65rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase'
                          }}
                        >
                          VIEW RECORD
                        </button>
                        {canCancel(booking) && (
                          <button
                            type="button"
                            onClick={() => requestCancelBooking(booking)}
                            style={{ background: 'transparent', border: '1px solid var(--status-danger, #dc2626)', color: 'var(--status-danger, #dc2626)', padding: '0.6rem 1rem', borderRadius: 'var(--admin-radius-sm)', fontSize: '0.65rem', fontWeight: '950', cursor: 'pointer', textTransform: 'uppercase' }}
                          >
                            CANCEL
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
        </>
      )}
    </div>
  );
};

export default AdminBookings;
