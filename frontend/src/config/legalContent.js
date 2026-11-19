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
  name: 'Comar Garage',
  version: '2.1.0',
  // Rendered as "Comar Garage v2.1.0" in the footer card.
  get buildLabel() {
    return `${this.name} v${this.version}`;
  },
  supportEmail: 'ajahorro@gmail.com',
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
    summary: 'The rules that govern your use of the Comar Garage booking platform.',
    sections: [
      {
        heading: '1. Acceptance of Terms',
        paragraphs: [
          'By creating an account or booking a service with Comar Garage, you agree to be bound by these Terms of Service and all applicable shop policies.',
          'If you do not agree with any part of these terms, you must not use the platform or book a service.',
        ],
      },
      {
        heading: '2. Bookings & Scheduling',
        paragraphs: [
          'All bookings are subject to vehicle condition, available staff capacity, and timing confirmation by Comar Garage.',
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
          'Comar Garage exercises reasonable care in handling all vehicles. Comar Garage is not liable for pre-existing damage, undeclared valuables left in the vehicle, or delays caused by events beyond its control.',
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
    summary: 'How we collect, use, and protect your personal information, in line with the Data Privacy Act of 2012 (RA 10173).',
    sections: [
      {
        heading: '1. Scope and Legal Basis',
        paragraphs: [
          'This Privacy Policy is adopted in compliance with the Data Privacy Act of 2012 (Republic Act No. 10173), its Implementing Rules and Regulations, and the issuances of the National Privacy Commission (NPC). It applies to all personal data Comar Garage collects through this platform from Customers, Staff, and Administrators.',
          'We process your personal data only on a lawful basis recognized under RA 10173: your consent, the performance of the booking contract you enter into with us, compliance with a legal obligation (such as tax and accounting records), or our legitimate business interest in operating the shop, provided this does not override your fundamental rights.',
        ],
      },
      {
        heading: '2. Information We Collect',
        paragraphs: [
          'We collect the information you provide during booking and account creation: your name, contact number, email address, vehicle details, and payment proof.',
          'We do not request or store government-issued identification numbers (such as a driver’s license, passport, or SSS/TIN number) through this platform.',
        ],
      },
      {
        heading: '3. How We Use Your Information',
        paragraphs: [
          'Personal information is processed for scheduling, service communication, payment verification, and account management only.',
          'We do not sell your personal information to third parties. Limited data is shared only with the service providers that run this platform (database, hosting, and email delivery), solely to operate the system, and under their own confidentiality and security obligations to us.',
        ],
      },
      {
        heading: '4. How We Protect Your Information',
        paragraphs: [
          'We implement reasonable and appropriate organizational, physical, and technical security measures, as required under RA 10173, proportionate to the personal data we hold.',
          'Technical measures include encrypted (HTTPS/TLS) data transmission, encrypted account credentials, database-level Row-Level Security that restricts each account to only the data its role is authorized to see, time-limited private links for uploaded payment receipts rather than public access, and an audit log of changes to sensitive records.',
          'Access to personal data within Comar Garage is limited to personnel who need it to perform their role, such as verifying a payment or assigning a technician.',
        ],
      },
      {
        heading: '5. Data Retention',
        paragraphs: [
          'Booking and payment records are retained for operational, accounting, and legal-compliance purposes, and no longer than reasonably necessary for those purposes or as required by applicable law. Deactivated accounts are retained for a 15-day recovery window before permanent purging.',
        ],
      },
      {
        heading: '6. Your Rights as a Data Subject',
        paragraphs: [
          'Under RA 10173, you have the right to: be informed that your personal data is being processed; access your personal data on reasonable request; correct any inaccurate or outdated personal data; object to or withdraw consent for processing, subject to legal or contractual limitations; request the erasure or blocking of your personal data when it is no longer necessary for the purpose it was collected for; be indemnified for damages from a violation of your rights; and lodge a complaint with the National Privacy Commission.',
          'You may review and update your personal information at any time from your profile.',
          'You may request deletion of your account data using the “Request Account Data Deletion” action in Settings. Some records may be retained for a limited period where required for accounting or legal-compliance purposes, as described in Section 5.',
        ],
      },
      {
        heading: '7. Consent',
        paragraphs: [
          'By submitting a booking you authorize Comar Garage to process the personal data required for service delivery, account management, and operational communications, as described in this Policy.',
        ],
      },
      {
        heading: '8. Data Breach Notification',
        paragraphs: [
          'In the event of a personal data breach that poses a real risk of serious harm to an affected individual, Comar Garage will notify the affected individual and the National Privacy Commission within the period required under RA 10173 and its Implementing Rules and Regulations.',
        ],
      },
      {
        heading: '9. Contact Us',
        paragraphs: [
          'For questions, concerns, or requests regarding your personal data or this Policy, you may reach us at ajahorro@gmail.com.',
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
          'Bookings above the shop’s set amount require a downpayment to secure the slot. The downpayment is deducted from your final bill.',
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
    roles: ['customer', 'admin'],
  },
  {
    key: 'promoEmailSms',
    label: 'Promotional SMS / discounts',
    description: 'Receive occasional promotions, discount codes, and seasonal offers.',
    defaultValue: false,
    roles: ['customer', 'admin'],
  },
  // Opt-in (OFF by default). The backend emails a customer about a NEW promo only when this is on and the promo
  // applies to a vehicle in their garage. Package promos and new services are never emailed.
  {
    key: 'emailNewPromos',
    label: 'Be the first to know about new promos',
    description: 'Get an email when a new promo is made for a vehicle in your garage.',
    defaultValue: false,
    roles: ['customer'],
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
