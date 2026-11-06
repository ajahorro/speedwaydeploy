import React from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useUnifiedData } from '../../context/UnifiedContext'; // 1. IMPORT OUR NEW BRAIN
import ActiveBookingContainer from '../../components/Customer/ActiveBookingContainer';
import UpcomingAppointments from '../../components/Customer/UpcomingAppointments';
import { TourLauncher } from '../../components/common/GuidedTour';
import { CUSTOMER_TOURS } from '../../features/tours/customerTours';

const CustomerDashboard = () => {
  const { user, profile } = useAuth();

  // 2. PULL LIVE REAL-TIME DATA
  const { bookings, isLoading: loading } = useUnifiedData();

  const allBookings = bookings || [];

  // 3. THE GHOST BOOKING FIX: 
  // Strictly filter out inactive statuses so they never show up in the trackers
  // most immediate first: a booking under way, then the soonest appointment
  const isUnderWay = (b) => (b.vehicles || []).some((v) => String(v.status || '').toUpperCase() === 'IN_PROGRESS');
  const activeTrackableBookings = allBookings
    .filter(b => !['cancelled', 'completed', 'released', 'flagged_noshow'].includes(b.status?.toLowerCase()))
    .sort((a, b) => (Number(isUnderWay(b)) - Number(isUnderWay(a))) || (new Date(a.start_datetime) - new Date(b.start_datetime)));

  // The 'Active' booking is the most immediate one
  const activeBooking = activeTrackableBookings[0] || null;
  // Fallback to latest finished/completed booking if no pending/ongoing appointment
  const recentBooking = !activeBooking ? allBookings.find(b => ['completed', 'released'].includes(b.status?.toLowerCase())) || null : null;
  // The rest fall into the upcoming tracker
  const upcomingBookings = activeTrackableBookings.slice(1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem', paddingBottom: '5rem' }}>

      {/* Header Section */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(1.8rem, 5vw, 2.5rem)', fontWeight: '950', margin: '0 0 0.5rem 0', letterSpacing: '-1.5px', textTransform: 'uppercase', color: 'var(--admin-text-primary)' }}>
            Welcome back, {profile?.first_name || 'Driver'}
          </h1>
          <p style={{ color: 'var(--admin-text-secondary)', margin: 0, fontSize: '0.95rem', fontWeight: '600', opacity: 0.8, display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            Your appointments and cars at a glance.
            <TourLauncher steps={CUSTOMER_TOURS.dashboard} label="How your dashboard works" />
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        {/* Left Column (Primary Focus) */}
        <div data-tour="cdash-active" style={{ flex: '1 1 60%', minWidth: 'min(100%, 320px)', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <ActiveBookingContainer booking={activeBooking} recentBooking={recentBooking} loading={loading} />
        </div>

        {/* Right Column (Secondary Focus) */}
        <div data-tour="cdash-upcoming" style={{ flex: '1 1 30%', minWidth: 'min(100%, 300px)', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          <UpcomingAppointments bookings={upcomingBookings} loading={loading} />
        </div>
      </div>

    </div>
  );
};

export default CustomerDashboard;