/**
 * Step-by-step guides for admin pages (the round "i" next to a title). Each step points at an element marked
 * data-tour="…" on that page. Text is plain English; the Filipino version comes from i18n/tl.json like the rest of
 * the app (the guide is translated on screen when the account's language is Filipino).
 * Keep steps short: one idea each, in the order a person would actually do things.
 */
export const ADMIN_TOURS = {
  services: [
    { target: '[data-tour="svc-vehicle"]', title: '1. Choose a vehicle', body: 'Pick the vehicle type you want to work on. The list below then shows only that vehicle’s services and prices. “All Vehicles” shows everything.' },
    { target: '[data-tour="svc-status"]', title: '2. Active or Archived', body: 'Active services are the ones customers can book. Switch to Archived to see services you have taken off the menu, so you can bring them back.' },
    { target: '[data-tour="svc-search"]', title: '3. Search', body: 'Type part of a service name, like “basic wash”. It only searches the vehicle you picked, so a car wash will not show up under Bigbike.' },
    { target: '[data-tour="svc-edit"]', title: '4. Make changes', body: 'Press Edit to unlock changes. You can then tick services to archive or restore several at once, or use Edit and Archive on a single row. Press Done when you are finished.' },
    { target: '[data-tour="svc-table"]', title: '5. Your services', body: 'Each row shows the price, how long it takes and whether it is live. Use the page arrows under the list to see more (10 per page).' },
  ],

  promos: [
    { target: '[data-tour="promo-mode"]', title: '1. Pick the kind of promo', body: 'Standard Promo takes money off each chosen service (for example 10% off). Package Promo sets one fixed price for a group of services taken together.' },
    { target: '[data-tour="promo-basics"]', title: '2. Name and discount', body: 'Give the promo a name customers will understand, then enter the discount: a percentage, a peso amount, or the package price.' },
    { target: '[data-tour="promo-dates"]', title: '3. When it runs', body: 'Choose the start and end date and time. Tick “Never Expires” to keep it running until you archive it.' },
    { target: '[data-tour="promo-binding"]', title: '4. Which vehicles and services', body: 'Tick a vehicle, then open it to choose its services. “Select all vehicles and services” ticks everything on every page at once.' },
    { target: '[data-tour="promo-explainer"]', title: '5. Check what it will do', body: 'This box explains, in plain words, what the promo you are making will do for the customer. Read it before you publish.' },
    { target: '[data-tour="promo-create"]', title: '6. Publish', body: 'The button unlocks once the name, discount, dates and at least one vehicle with a service are filled in. Promos cannot be edited later; archive one and make a new one instead.' },
    { target: '[data-tour="promo-list"]', title: '7. Current and archived promos', body: 'Running and upcoming promos are listed here, 4 per page. Expired and archived ones move to “View archived”.' },
    { target: '[data-tour="promo-codes"]', title: '8. Promo codes', body: 'Codes are typed by the customer on the last booking page. Set the discount, vehicles, dates and how many times a code can be used.' },
  ],

  about: [
    { target: '[data-tour="about-sec-hero"]', title: '1. Top banner photo', body: 'Click a section to open it. This one holds the wide photo at the top of the landing page. It is darkened so the headline stays readable; without one, the banner is plain dark.' },
    { target: '[data-tour="about-sec-text"]', title: '2. About text', body: 'The About heading and paragraph. “Use the standard text” brings back the original wording.' },
    { target: '[data-tour="about-sec-cards"]', title: '3. Highlights', body: 'Up to 4 small cards next to the text. Pick an icon, write a short title and an optional line.' },
    { target: '[data-tour="about-sec-photos"]', title: '4. Photos and layout', body: 'Upload up to 12 photos with captions and pick how they are arranged. They show in the order you upload them. Photos are optional.' },
    { target: '[data-tour="about-sec-map"]', title: '5. Map pin', body: 'Search the shop’s address or click the map, then drag the pin to the exact spot. A pin is required.' },
    { target: '[data-tour="about-sections"]', title: '6. Preview and save each part', body: 'Every open section has its own See preview, Discard and Save changes. Saving one section does not touch the others, and “Unsaved changes” shows which ones you still need to save.' },
  ],

  payments: [
    { target: '[data-tour="pay-search"]', title: '1. Find a payment', body: 'Search by customer name, reference number or amount.' },
    { target: '[data-tour="pay-filter"]', title: '2. Pending or processed', body: 'Pending payments are waiting for you to check. Processed ones are done; cash payments always count as processed. Under Processed you can show only Digital or Cash.' },
    { target: '[data-tour="pay-list"]', title: '3. Pick a payment', body: 'Click a payment to open its details. The list shows 10 per page.' },
    { target: '[data-tour="pay-details"]', title: '4. Check and decide', body: 'Compare the receipt photo with “Show scanned details” (what the system read from it). If the amount and reference match, press Verify Paid; if not, press Reject and give a reason.' },
  ],

  newBooking: [
    { target: '[data-tour="book-customer"]', title: '1. Who is it for?', body: 'Choose Existing Customer to book for someone with an account (browse or search by name), or Walk-in Guest to type a new person’s details.' },
    { target: '[data-tour="book-steps"]', title: '2. Four short steps', body: 'Services, then schedule, then a check of each vehicle, then review and payment. You can tap a finished step to go back to it.' },
    { target: '[data-tour="book-content"]', title: '3. Fill in the step', body: 'Add each vehicle and its services here, then press Next. Your progress is saved on this device, so you can come back to it.' },
  ],

  dashboard: [
    { target: '[data-tour="dash-attention"]', title: '1. What needs you now', body: 'Each card counts something waiting for an admin: payments to check, bookings with no technician, no-shows, refund requests and finished cars to hand back. Click a card to open that list.' },
    { target: '[data-tour="dash-queue"]', title: '2. Live booking queue', body: 'Today’s and upcoming bookings, updated on their own. Click a row to open the booking, or “View all queue” for the full list.' },
    { target: '[data-tour="admin-nav"]', title: '3. Everything else', body: 'The menu on the left opens every part of the system. On a phone, open it with the menu button at the top.' },
  ],

  hub_profile: [
    { target: '[data-tour="hub-search"]', title: '1. Search the settings', body: 'Type what you want to change, like “opening time”, “promo” or “map pin”, and pick a result. It opens the right tab and section and points to the setting.' },
    { target: '[data-tour="hub-tabs"]', title: '2. Business Hub tabs', body: 'Each tab covers one part of the shop: profile, About & Map, schedule, services and promos, terms and policies. The “i” guide always explains the tab that is open.' },
    { target: '[data-tour="hub-profile-details"]', title: '3. Shop details', body: 'The shop’s name, contact number, email and address. Customers see these on the website, receipts and emails.' },
    { target: '[data-tour="hub-faq"]', title: '4. Questions and answers', body: 'The FAQ shown on the landing page. Add, edit, reorder or remove questions here.' },
    { target: '[data-tour="hub-save-profile"]', title: '5. Save', body: 'Changes only go live after you save. The button stays off until something has changed and every required field is filled in.' },
  ],

  hub_about: [
    { target: '[data-tour="hub-tabs"]', title: '1. Business Hub tabs', body: 'Each tab covers one part of the shop. This one controls the banner photo, About text, highlights, photos and map on the landing page.' },
    { target: '[data-tour="about-sec-hero"]', title: '2. Top banner photo', body: 'Click a section to open it. This one holds the wide photo at the top of the landing page. It is darkened so the headline stays readable; without one, the banner is plain dark.' },
    { target: '[data-tour="about-sec-text"]', title: '3. About text', body: 'The About heading and paragraph. “Use the standard text” brings back the original wording.' },
    { target: '[data-tour="about-sec-cards"]', title: '4. Highlights', body: 'Up to 4 small cards next to the text. Pick an icon, write a short title and an optional line.' },
    { target: '[data-tour="about-sec-photos"]', title: '5. Photos and layout', body: 'Upload up to 12 photos with captions and pick how they are arranged. They show in the order you upload them. Photos are optional.' },
    { target: '[data-tour="about-sec-map"]', title: '6. Map pin', body: 'Search the shop’s address or click the map, then drag the pin to the exact spot. A pin is required.' },
    { target: '[data-tour="about-sections"]', title: '7. Preview and save each part', body: 'Every open section has its own See preview, Discard and Save changes. Saving one section does not touch the others, and “Unsaved changes” shows which ones you still need to save.' },
  ],

  hub_schedule: [
    { target: '[data-tour="hub-tabs"]', title: '1. Business Hub tabs', body: 'Each tab covers one part of the shop. This one controls when customers can book.' },
    { target: '[data-tour="hub-schedule-rules"]', title: '2. Opening hours and booking rules', body: 'Set how far ahead a booking must be made, how many cars the shop takes at a time, opening hours and regular closing days. Save before leaving the tab.' },
    { target: '[data-tour="hub-closures"]', title: '3. Holidays and closures', body: 'Close the shop for a whole day, a few hours, or several days in a row (holidays, training, maintenance). Customers cannot book those times.' },
  ],

  hub_services: [
    { target: '[data-tour="hub-tabs"]', title: '1. Business Hub tabs', body: 'Each tab covers one part of the shop. This one holds every service, its prices, and the promos.' },
    { target: '[data-tour="hub-svc-existing"]', title: '2. Your services', body: 'Open this to see, search, edit, archive or restore services for each vehicle type. It has its own “i” guide inside.' },
    { target: '[data-tour="hub-svc-add"]', title: '3. Add a service', body: 'Add a new service to vehicle types the shop already serves, with a price and how long it takes for each.' },
    { target: '[data-tour="hub-svc-vehicle"]', title: '4. Add a vehicle type', body: 'Start serving a new kind of vehicle. Give it at least one service so customers can book it.' },
    { target: '[data-tour="hub-promos"]', title: '5. Promos and packages', body: 'Open this to create discounts, packages and promo codes for the services above. It has its own “i” guide inside.' },
  ],

  hub_terms: [
    { target: '[data-tour="hub-tabs"]', title: '1. Business Hub tabs', body: 'Each tab covers one part of the shop. This one holds the terms and the privacy & security policy people agree to, and the payment policy.' },
    { target: '[data-tour="hub-terms-terms"]', title: '2. Terms and conditions', body: 'The terms customers, staff and admins accept, one version per role. Publishing a new version asks everyone to accept it again.' },
    { target: '[data-tour="hub-terms-security"]', title: '3. Privacy & security policy', body: 'How the shop protects personal information and accounts, one version per role. Like the terms, publishing a new version asks everyone in that role to agree again when they next sign in.' },
    { target: '[data-tour="hub-terms-payments"]', title: '4. Payment policy', body: 'How much a customer pays up front before work starts. The preview shows what customers will pay for a few example totals.' },
  ],

  receipts: [
    { target: '[data-tour="rcp-totals"]', title: '1. Totals', body: 'Verified payments, refunds sent, and online payments with no uploaded proof, for the records shown below.' },
    { target: '[data-tour="rcp-filters"]', title: '2. Narrow the list', body: 'Show only verified, waiting, rejected or refund records, or filter by method, proof and dates. Export CSV saves exactly what is shown.' },
    { target: '[data-tour="rcp-search"]', title: '3. Search', body: 'Type a receipt number, payment reference, customer name, booking number or amount.' },
    { target: '[data-tour="rcp-list"]', title: '4. Proof and receipt', body: 'Click a proof to view it full size. Receipt opens the numbered acknowledgement receipt to print or save; Booking opens the booking.' },
  ],
  refunds: [
    { target: '[data-tour="ref-search"]', title: '1. Find a refund', body: 'Search by customer name or booking number.' },
    { target: '[data-tour="ref-filter"]', title: '2. Pending or processed', body: 'Pending refunds are waiting for you to send the money back. Processed ones are done; under Processed you can show only Digital or Cash.' },
    { target: '[data-tour="ref-list"]', title: '3. Pick a request', body: 'Each card is a cancelled or no-show booking with money to return. Click one to open it.' },
    { target: '[data-tour="ref-details"]', title: '4. Send the refund', body: 'Choose the reason and how the money was sent. For a bank or e-wallet transfer, upload a screenshot of it; the system reads the amount to help you check. Then press Process Refund. The customer is emailed automatically.' },
  ],

  reports: [
    { target: '[data-tour="rep-range"]', title: '1. Choose the dates', body: 'Pick a ready range (like this month) or your own dates. Everything on the page follows these dates.' },
    { target: '[data-tour="rep-tabs"]', title: '2. Pick a view', body: 'Overview shows the totals; the other tabs list bookings, payments, refunds and credits, and balances still owed.' },
    { target: '[data-tour="rep-actions"]', title: '3. Export, print or ask', body: 'Download a spreadsheet or print the tab you are on, get a full PDF report, or ask the AI a question about the numbers.' },
    { target: '[data-tour="rep-kpis"]', title: '4. Sales and balances', body: 'Gross sales is the price of the services sold; discounts and promos are taken off to give net sales; average sale is net sales per booking. Refunds and pending cover the dates chosen; outstanding, deferred and customer credit are as of today.' },
    { target: '[data-tour="rep-chart"]', title: '5. Money over time', body: 'Money collected, refunds and payments waiting for checking, day by day. Point at the chart to see a day’s numbers.' },
    { target: '[data-tour="rep-breakdown"]', title: '6. How customers pay, and what they buy', body: 'Money collected by payment method, and the services booked most.' },
  ],

  bookingDetails: [
    { target: '[data-tour="bd-actions"]', title: '1. Booking actions', body: 'Reschedule, allow an early start, cancel or flag a no-show from here. Buttons only appear when that action is allowed for the booking’s current status.' },
    { target: '[data-tour="bd-ledger"]', title: '2. Money', body: 'Every payment, top-up and refund for this booking, with what is still owed. Record a cash or digital payment here.' },
    { target: '[data-tour="bd-units"]', title: '3. Vehicles and technicians', body: 'Each vehicle in the booking, its services and its technician. Assign or change a technician here (it locks once they take the “before” photo).' },
    { target: '[data-tour="bd-payment"]', title: '4. Payment check', body: 'The receipt the customer sent and what the system read from it. Approve or reject it here.' },
    { target: '[data-tour="bd-audit"]', title: '5. History', body: 'Everything that happened to this booking, who did it and when.' },
  ],
};
