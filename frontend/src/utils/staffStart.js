/**
 * What stands between a technician and "Start service" for one assigned vehicle.
 *
 * Starting needs three things: the technician is on shift, at least one BEFORE
 * photo exists, and the scheduled time has arrived (on the day of the booking).
 * There is no upper limit here: once the time has arrived the job can be started
 * until the booking is flagged as a no-show (that rule lives in the database).
 */
export const startReadiness = ({ clockedIn, beforePhotos = 0, startDatetime, now = new Date() }) => {
  const scheduled = startDatetime ? new Date(startDatetime) : null;
  const hasTime = Boolean(scheduled) && Number.isFinite(scheduled.getTime());
  const timeReached = hasTime && scheduled.getTime() <= now.getTime();
  const sameDay = hasTime && scheduled.toDateString() === now.toDateString();
  const timeLabel = hasTime
    ? scheduled.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';

  const steps = [
    { key: 'duty', ok: Boolean(clockedIn), label: clockedIn ? 'On shift' : 'Clock in for your shift' },
    { key: 'photo', ok: beforePhotos >= 1, label: beforePhotos >= 1 ? 'Before photo added' : 'Add a before photo' },
    {
      key: 'time',
      ok: timeReached && sameDay,
      label: !hasTime
        ? 'No scheduled time'
        : (!timeReached ? `Opens at ${timeLabel}` : (sameDay ? 'Scheduled time reached' : 'Booked for another day'))
    }
  ];

  return { ok: steps.every((step) => step.ok), steps };
};
