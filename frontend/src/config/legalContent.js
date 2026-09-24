/**
 * Static legal & policy documents + app metadata for the Settings pages.
 *
 * Why a static config (not a DB table): legal copy must be reviewable in the
 * repository, versioned with the code, and identical for every role. It is read
 * once here and rendered through the app's modal system so it stays consistent
 * across the Admin, Staff, and Customer dashboards.
 *
 * NOTE: The placeholder clauses below are the canonical shop policy text. When
 * the studio's lawyer finalises the wording, edit ONLY this file — every screen
 * picks the change up automatically.
 */

export const APP_METADATA = Object.freeze({
  name: 'Speedway Detailing Hub',
  version: '2.1.0',
  // Rendered as "Speedway Detailing Hub v2.1.0" in the footer card.
  get buildLabel() {
    return `${this.name} v${this.version}`;
  },
  supportEmail: 'support@speedwaydetailing.ph',
});

/**
 * The three policy documents required by the directive. Each entry is either a
 * list of paragraphs or a list of { heading, paragraphs } sections so the modal
 * renderer can lay them out without a markdown dependency.
 */
export const LEGAL_DOCUMENTS = Object.freeze([
  {
    id: 'terms',
    title: 'Terms of Service',
    eyebrow: 'LEGAL',
    summary: 'The rules that govern your use of the Speedway booking platform.',
    sections: [
      {
        heading: '1. Acceptance of Terms',
        paragraphs: [
          'By creating an account or booking a service with Speedway AutoxMoto Detail Studio, you agree to be bound by these Terms of Service and all applicable shop policies.',
          'If you do not agree with any part of these terms, you must not use the platform or book a service.',
        ],
      },
      {
        heading: '2. Bookings & Scheduling',
        paragraphs: [
          'All bookings are subject to vehicle condition, available staff capacity, and timing confirmation by the studio.',
          'Customers agree to provide truthful vehicle details and to keep their contact information current for appointment updates.',
        ],
      },
      {
        heading: '3. Payments',
        paragraphs: [
          'Digital payments (e-wallet or bank transfer) must be supported by a valid proof of payment. Receipts are verified automatically where possible and manually audited when required.',
          'A booking is only considered secured once the required downpayment or full payment is verified.',
        ],
      },
      {
        heading: '4. Liability',
        paragraphs: [
          'The studio exercises reasonable care in handling all vehicles. The studio is not liable for pre-existing damage, undeclared valuables left in the vehicle, or delays caused by events beyond its control.',
        ],
      },
      {
        heading: '5. Changes to These Terms',
        paragraphs: [
          'These terms may be updated from time to time. Continued use of the platform after an update constitutes acceptance of the revised terms.',
        ],
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy Policy',
    eyebrow: 'DATA PRIVACY',
    summary: 'How we collect, use, and protect your personal information.',
    sections: [
      {
        heading: '1. Information We Collect',
        paragraphs: [
          'We collect the information you provide during booking and account creation: your name, contact number, email address, vehicle details, and payment proof.',
        ],
      },
      {
        heading: '2. How We Use Your Information',
        paragraphs: [
          'Personal information is processed for scheduling, service communication, payment verification, and account management only.',
          'We do not sell your personal information to third parties.',
        ],
      },
      {
        heading: '3. Data Retention',
        paragraphs: [
          'Booking and payment records are retained for operational, accounting, and legal-compliance purposes. Deactivated accounts are retained for a 15-day recovery window before permanent purging.',
        ],
      },
      {
        heading: '4. Your Rights',
        paragraphs: [
          'You may review and update your personal information at any time from your profile.',
          'You may request deletion of your account data using the “Request Account Data Deletion” action in Settings.',
        ],
      },
      {
        heading: '5. Consent',
        paragraphs: [
          'By submitting a booking you authorize the studio to process the personal data required for service delivery, account management, and operational communications.',
        ],
      },
    ],
  },
  {
    id: 'cancellation',
    title: 'Cancellation & Refund Policy',
    eyebrow: 'PAYMENTS',
    summary: 'Shop deposit, cancellation, and refund guidelines.',
    sections: [
      {
        heading: '1. Downpayments',
        paragraphs: [
          'Bookings above the studio threshold require a downpayment to secure the slot. The downpayment is deducted from your final bill.',
        ],
      },
      {
        heading: '2. Cancellations',
        paragraphs: [
          'Cancellations made before the service begins may be eligible for a refund or rescheduling, subject to the notice period.',
          'No-show bookings may be cancelled automatically and the downpayment may be forfeited.',
        ],
      },
      {
        heading: '3. Refunds',
        paragraphs: [
          'Approved refunds are queued and processed to the original payment method. Processing time depends on your e-wallet or bank.',
          'Rejected payments that were already made are queued for refund automatically.',
        ],
      },
      {
        heading: '4. Rescheduling',
        paragraphs: [
          'You may reschedule a confirmed booking to another available slot at no extra cost, subject to availability.',
        ],
      },
    ],
  },
]);

export const getLegalDocument = (id) => LEGAL_DOCUMENTS.find((doc) => doc.id === id) || null;

/**
 * Communication preference descriptors. The `key` maps to the persisted
 * preference object; `defaultValue` is what a brand-new account starts with.
 * `roles` restricts which dashboards offer the toggle.
 */
export const COMMUNICATION_PREFERENCES = Object.freeze([
  {
    key: 'emailBookingUpdates',
    label: 'Email booking updates',
    description: 'Receive email alerts when your booking status changes or a payment is verified.',
    defaultValue: true,
    roles: ['customer', 'staff', 'admin'],
  },
  {
    key: 'promoEmailSms',
    label: 'Promotional SMS / discounts',
    description: 'Receive occasional promotions, discount codes, and seasonal offers.',
    defaultValue: false,
    roles: ['customer', 'staff', 'admin'],
  },
  // ── Granular customer marketing toggles (opt-in). Each is OFF by default;
  // promos/services/vehicles are only emailed when the customer explicitly
  // turns the matching switch on. Consumed by the notification dispatch path. ──
  {
    key: 'emailNewPromos',
    label: 'Email me about new promos',
    description: 'Get an email whenever the shop launches a new promotion or discount.',
    defaultValue: false,
    roles: ['customer'],
  },
  {
    key: 'emailNewServices',
    label: 'Email me about new services',
    description: 'Get an email when a new service is added to the catalog.',
    defaultValue: false,
    roles: ['customer'],
  },
  {
    key: 'emailNewVehicles',
    label: 'Email me about new vehicle categories',
    description: 'Get an email when the shop starts servicing a new vehicle category.',
    defaultValue: false,
    roles: ['customer'],
  },
  {
    key: 'jobAssignmentAlerts',
    label: 'Job Assignment Alerts',
    description: 'Alert when a vehicle is assigned to your bay.',
    defaultValue: true,
    roles: ['staff'],
  },
  {
    key: 'scheduleRosterChanges',
    label: 'Schedule & Roster Changes',
    description: 'Alert when shift hours change.',
    defaultValue: true,
    roles: ['staff'],
  },
  {
    key: 'soundHapticChime',
    label: 'Sound & Haptic Chime',
    description: 'Audio chime on new job queue.',
    defaultValue: false,
    roles: ['staff'],
  },
  {
    key: 'staffLandingView',
    label: 'Default Landing View',
    description: 'Choose which job board opens first for your workstation.',
    defaultValue: 'assigned',
    roles: ['staff'],
  },
]);/**
 * Internal Shop SOP & Quality-Control guidelines shown to STAFF.
 * Kept here (not in the DB) so the standard operating procedure is versioned
 * with the app and identical for every technician.
 */
export const SHOP_SOP = Object.freeze({
  id: 'sop',
  title: 'Internal Shop SOP & Guidelines',
  eyebrow: 'STAFF',
  summary: 'Quality-control and bay operating procedures for technicians.',
  sections: [
    {
      heading: '1. Bay Preparation',
      paragraphs: [
        'Inspect the assigned bay before pulling a vehicle in: clear debris, verify water and chemical supply, and confirm equipment is operational.',
        'Check in with the service advisor for any special instructions on the assigned vehicle.',
      ],
    },
    {
      heading: '2. Vehicle Handling',
      paragraphs: [
        'Photograph the vehicle condition on intake before beginning any work.',
        'Report pre-existing damage, missing items, or customer valuables to the service advisor immediately.',
      ],
    },
    {
      heading: '3. Quality Control',
      paragraphs: [
        'Perform a final walk-around inspection against the booked service checklist before marking a job complete.',
        'Any rework required is the responsibility of the technician who completed the job.',
      ],
    },
    {
      heading: '4. Safety & Escalation',
      paragraphs: [
        'Use personal protective equipment at all times in the bay area.',
        'Escalate accidents, equipment failures, or customer concerns to a supervisor without delay.',
      ],
    },
  ],
});
