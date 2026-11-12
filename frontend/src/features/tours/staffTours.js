/**
 * The “i” guides on the technician pages. Each step points at an element marked data-tour="…" on that page.
 * Plain words; every title and body has a Tagalog version in i18n/tl.json.
 */
export const STAFF_TOURS = {
  dashboard: [
    { target: '[data-tour="sdash-shift"]', title: '1. Your shift', body: 'Shows whether a job is in progress. Clock in on the Duty page before you start any job.' },
    { target: '[data-tour="sdash-list"]', title: '2. Your assigned vehicles', body: 'Only the vehicles assigned to you, in order of appointment time. Tap one to open its job card.' },
  ],
  duty: [
    { target: '[data-tour="sduty-clock"]', title: '1. Clock in and out', body: 'Clock in when your shift starts so you can receive and start jobs. Clock out when you are done.' },
    { target: '[data-tour="sduty-station"]', title: '2. Your station', body: 'The shop sets your bay or station. You become available for the bays you are assigned to once you clock in.' },
  ],
  job: [
    { target: '[data-tour="sjob-vehicle"]', title: '1. The vehicle and its services', body: 'The vehicle, plate number, status and the services you need to do.' },
    { target: '[data-tour="sjob-evidence"]', title: '2. Photos and notes', body: 'Add at least one before photo, and one photo of the finished work. Notes are saved for the admin and the customer.' },
    { target: '[data-tour="sjob-start"]', title: '3. Start or finish the job', body: 'The checklist shows what is still missing. When every item is checked, press Start service. When the work is done, press Mark as finished.' },
  ],
  notifications: [
    { target: '[data-tour="snot-filters"]', title: '1. Find an update', body: 'Search your notifications, or show only the unread or read ones.' },
    { target: '[data-tour="snot-list"]', title: '2. Your updates', body: 'New assignments and changes to your jobs. Tap one to read it in full.' },
  ],
  reports: [
    { target: '[data-tour="srep-tabs"]', title: '1. Shop or your own work', body: 'All bookings shows the whole shop. My work shows only the jobs you did. Payments, prices and customer contacts are never shown.' },
  ],
  history: [
    { target: '[data-tour="shist-calendar"]', title: '1. Pick a day', body: 'Choose a day to see when you clocked in and out, and the vehicles and services you worked on.' },
  ],
  profile: [
    { target: '[data-tour="sprof-identity"]', title: '1. Your details', body: 'Your name and contact details, as the shop has them.' },
    { target: '[data-tour="sprof-password"]', title: '2. Change password', body: 'Enter your current password, then the new one. We never ask for your password by email or chat.' },
  ],
  settings: [
    { target: '[data-tour="sset-prefs"]', title: '1. Your preferences', body: 'Language (English or Tagalog), light or dark look, and which alerts you get.' },
  ],
};
