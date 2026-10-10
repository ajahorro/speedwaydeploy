import React from 'react';
import { useAuth } from '../../hooks/useAuth';
import PageHeader from '../../components/PageHeader';
import StaffHistoryCalendar from '@/features/staff-history/StaffHistoryCalendar';

/** The technician's own history: pick a day on the calendar to see the clock-ins and the services done that day. */
const StaffWorkHistory = () => {
  const { profile } = useAuth();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <PageHeader
        badge="Work History"
        title="Attendance and vehicles"
        subtitle="Pick a day to see when you clocked in and out and the services you did."
      />
      <StaffHistoryCalendar staffId={profile?.id} />
    </div>
  );
};

export default StaffWorkHistory;
