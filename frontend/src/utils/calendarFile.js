// "Add to calendar": a standard .ics file that phone and computer calendars (Google, Apple, Outlook) open,
// with a reminder one hour before.
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (t) => String(t || '').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');

export function downloadCalendarEvent({ id, title, start, end, location, description }) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Comar Garage//Booking//EN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${id}@comargarage.com`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end || new Date(new Date(start).getTime() + 3600000))}`,
    `SUMMARY:${esc(title)}`, `LOCATION:${esc(location)}`, `DESCRIPTION:${esc(description)}`,
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: `comar-garage-booking-${String(id).slice(0, 8)}.ics` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
