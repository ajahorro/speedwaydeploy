import React from 'react';
import { useAuth } from '../../hooks/useAuth';
import PageHeader from '../../components/PageHeader';
import WorkHistoryByDay from '@/features/staff-history/WorkHistoryByDay';

/** The technician's own history: clock-ins and vehicles by day (the same view an administrator opens from the account list). */
const StaffWorkHistory = () => {
  const { profile } = useAuth();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', paddingBottom: '2rem' }}>
      <PageHeader
        badge="Work History"
        title="Attendance and vehicles"
        subtitle="Pick a day to see when you clocked in and out and the vehicles you worked on."
      />
      <div className="ui-root" style={{ maxWidth: '760px' }}>
        <WorkHistoryByDay staffId={profile?.id} />
      </div>
    </div>
  );
};

export default StaffWorkHistory;
