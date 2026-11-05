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
    { target: '[data-tour="about-add"]', title: '1. Add photos', body: 'Upload up to 12 photos of the shop. They are resized and cleaned of hidden data (like GPS) automatically.' },
    { target: '[data-tour="about-photos"]', title: '2. Captions and order', body: 'Write a short caption under each photo, use the arrows to change the order, or remove a photo. Photos are optional.' },
    { target: '[data-tour="about-layout"]', title: '3. Choose a layout', body: 'Pick how the photos and captions are arranged on the landing page: Mosaic, Slideshow, Grid or Story.' },
    { target: '[data-tour="about-search"]', title: '4. Find the shop', body: 'Type the shop’s address and press Search, then pick the right match. The pin drops there.' },
    { target: '[data-tour="about-map"]', title: '5. Fine-tune the pin', body: 'Drag the pin or click the map to put it on the exact spot. A pin is required before you can save.' },
    { target: '[data-tour="about-save"]', title: '6. Preview and save', body: '“See preview” shows the landing page with your changes before anything is saved. Save puts them live; Discard undoes them.' },
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

  bookingDetails: [
    { target: '[data-tour="bd-actions"]', title: '1. Booking actions', body: 'Reschedule, allow an early start, cancel or flag a no-show from here. Buttons only appear when that action is allowed for the booking’s current status.' },
    { target: '[data-tour="bd-ledger"]', title: '2. Money', body: 'Every payment, top-up and refund for this booking, with what is still owed. Record a cash or digital payment here.' },
    { target: '[data-tour="bd-units"]', title: '3. Vehicles and technicians', body: 'Each vehicle in the booking, its services and its technician. Assign or change a technician here (it locks once they take the “before” photo).' },
    { target: '[data-tour="bd-payment"]', title: '4. Payment check', body: 'The receipt the customer sent and what the system read from it. Approve or reject it here.' },
    { target: '[data-tour="bd-audit"]', title: '5. History', body: 'Everything that happened to this booking, who did it and when.' },
  ],
};
