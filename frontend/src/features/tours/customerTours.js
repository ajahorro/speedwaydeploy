/**
 * The “i” guides on the customer pages. Each step points at an element marked data-tour="…" on that page.
 * Plain words, no jargon; every title and body has a Tagalog version in i18n/tl.json.
 */
export const CUSTOMER_TOURS = {
  dashboard: [
    { target: '[data-tour="cust-nav"]', title: '1. Your menu', body: 'Go to your bookings, book a new appointment, see your payments, manage your cars, and change your settings.' },
    { target: '[data-tour="cdash-active"]', title: '2. Your current booking', body: 'Your next or ongoing appointment, with its status. Open it to see the details, pay a balance or message the shop.' },
    { target: '[data-tour="cdash-upcoming"]', title: '3. Coming up', body: 'Your other upcoming appointments, in date order.' },
  ],
  book: [
    { target: '[data-tour="book-steps"]', title: '1. Four short steps', body: 'Choose your car and services, pick a date and time, check each car, then review and pay. Tap a finished step to go back to it.' },
    { target: '[data-tour="book-content"]', title: '2. Fill in the step', body: 'Add your car and the services you want, then press Next. Your progress is saved on this device, so you can come back to it.' },
  ],
  bookings: [
    { target: '[data-tour="cbk-new"]', title: '1. Book an appointment', body: 'Start a new booking for one or more of your cars.' },
    { target: '[data-tour="cbk-filters"]', title: '2. Find a booking', body: 'Search by booking number or car, or show only upcoming or past appointments.' },
    { target: '[data-tour="cbk-list"]', title: '3. Your bookings', body: 'Tap a booking to see its details, payments and photos of your car.' },
  ],
  bookingDetails: [
    { target: '[data-tour="cbd-summary"]', title: '1. Booking summary', body: 'The date and time, your technician, the status of the job and how much is paid.' },
    { target: '[data-tour="cbd-receipt"]', title: '2. Your receipt', body: 'After the shop checks your payment, open or print your acknowledgement receipt here. It is also emailed to you.' },
    { target: '[data-tour="cbd-main"]', title: '3. Cars and services', body: 'Each car on this booking and its services. When the job is done, you can see the before-and-after photos.' },
    { target: '[data-tour="cbd-billing"]', title: '4. Payments', body: 'Every payment you made and the balance left. Pay the balance here if there is one.' },
    { target: '[data-tour="cbd-actions"]', title: '5. Change or cancel', body: 'Move your appointment to another time, or cancel it before the service starts. Any money that can be returned goes for refund review.' },
  ],
  billing: [
    { target: '[data-tour="cbill-totals"]', title: '1. Totals', body: 'How much you have paid in total, and any balance you still owe.' },
    { target: '[data-tour="cbill-ledger"]', title: '2. Payment history', body: 'Every payment and refund. Open one to see, download or print its acknowledgement receipt.' },
  ],
  garage: [
    { target: '[data-tour="cgar-vehicles"]', title: '1. Your cars', body: 'Add your cars here once, with their plate numbers, so booking is faster next time.' },
    { target: '[data-tour="cgar-fleets"]', title: '2. Fleet groups', body: 'Group several cars together (for example, family or company cars) to book them in one go.' },
  ],
  profile: [
    { target: '[data-tour="cprof-info"]', title: '1. Your details', body: 'Your name, phone number and email. Press Edit Profile to change them.' },
    { target: '[data-tour="cprof-password"]', title: '2. Change password', body: 'Enter your current password, then the new one twice. We never ask for your password by email or chat.' },
    { target: '[data-tour="cprof-account"]', title: '3. Your account', body: 'Turn off your account. You have 15 days to change your mind before your personal details are deleted.' },
  ],
  settings: [
    { target: '[data-tour="cset-prefs"]', title: '1. Your preferences', body: 'Language (English or Tagalog), light or dark look, and which emails and alerts you get, including promos.' },
    { target: '[data-tour="cset-account"]', title: '2. Profile and password', body: 'A shortcut to your profile page.' },
    { target: '[data-tour="cset-legal"]', title: '3. Terms and privacy', body: 'Read the terms and conditions and the privacy and security policy you agreed to.' },
  ],
};
