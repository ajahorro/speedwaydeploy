// A no-show can still be rescheduled until 24 hours after it was flagged (start + 1 hour grace + 24 hours);
// after that the shop cancels it. The database enforces the same deadline (no_show_undo_deadline).
export const isNoShow = (booking) => ['FLAGGED_NOSHOW', 'NO_SHOW'].includes(String(booking?.status || '').toUpperCase());
export const noShowDeadline = (booking) => (booking?.start_datetime ? new Date(new Date(booking.start_datetime).getTime() + 25 * 3600000) : null);
export const canRescheduleNoShow = (booking) => isNoShow(booking) && (!booking?.start_datetime || Date.now() < noShowDeadline(booking).getTime());
export const canRescheduleBooking = (booking) => ['scheduled', 'confirmed'].includes(String(booking?.status || '').toLowerCase()) || canRescheduleNoShow(booking);
