# COMAR GARAGE ALPHA TESTING CHECKLIST

*Based on the ISO/IEC 25010 Software Product Quality Model*

## Tester information

| Name of tester | Date |
|---|---|
|  |  |

| Account type / role | Browser and version |
|---|---|
| Customer / Staff (Technician) / Administrator |  |

| Device / screen size | Build or test date |
|---|---|
|  |  |

## Instructions

Evaluate only the statements that apply to the account type you used. For each statement, select one rating from 5 (Strongly Agree) to 1 (Strongly Disagree), then use the comments column for an observation, example, or defect ID. Answer from your experience using the system, not from assumptions about how it is implemented. Leave an item unrated if you did not encounter it; mark it **N/A** only when it does not apply to your role or the system.

For money, access control, booking acceptance, and data-loss issues, describe the affected booking or test account in the comments and report the defect promptly. Use test accounts and test payment evidence only.

## Rating scale

| Scale | Range | Verbal interpretation |
|---:|---:|---|
| 5 | 4.21–5.00 | Excellent / Strongly Agree |
| 4 | 3.41–4.20 | Very Good / Agree |
| 3 | 2.61–3.40 | Good / Neutral |
| 2 | 1.81–2.60 | Fair / Disagree |
| 1 | 1.00–1.80 | Poor / Strongly Disagree |

Select a single rating per applicable statement. Record that rating in **Score**. Calculate a section average from rated items only; exclude N/A and unanswered items.

## A. Alpha testing checklist (ISO/IEC 25010)

### 1. Functional suitability

#### 1.1 Customer / self-service account

Complete this subsection when testing with a Customer account.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Functional suitability | I can book one or more vehicles in one session and choose the appropriate services for each vehicle. (REQ-CST-01, REQ-CST-12) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Vehicle-specific prices, applicable promotions, booking total, and required downpayment are clear and correct before I submit a booking. (REQ-CST-02, SYS-09) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | The available appointment dates and times reflect shop hours, closures, blocked slots, capacity, and service duration. (REQ-CST-03, SYS-03) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can submit an eligible payment using the displayed shop QR code and receipt upload, understand the receipt-reading result before submission, and choose cash when the booking is below the shop's cash limit. (REQ-CST-04, SYS-01) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | The booking lets me pay an outstanding balance and clearly shows when a payment needs shop verification. (REQ-CST-05, CST-11) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Before work starts, I can request an additional service and see whether it changes the schedule or requires additional payment. (REQ-CST-06) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Each vehicle's progress, assigned technician, service photos, and service notes are available from my booking when applicable. (REQ-CST-07, REQ-CST-08) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Book Again correctly reuses my previous vehicles and services, and my Vehicle Garage retains vehicle details and service history. (REQ-CST-09, REQ-CST-12) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Eligible rescheduling and cancellation actions show the outcome clearly, and cancellation queues any eligible refund. (REQ-CST-10) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Transactions and Billing show my payment history, receipt decisions, balance, refund status, and downloadable receipts or statements accurately. (REQ-CST-11, SYS-08) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | My dashboard and Notification Center show relevant booking, payment, assignment, service, reminder, and completion updates. (REQ-CST-13, REQ-CST-16) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can manage my own profile and credentials. (REQ-CST-14) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Each booking has a message thread where I can exchange messages, photos, and payment proof with the Administrator. (REQ-CST-15) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

#### 1.2 Staff / technician account

Complete this subsection when testing with a Staff account.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Functional suitability | I can clock in and out, and my shift status correctly reflects my availability for work. (REQ-STF-01, SYS-04) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | My job list contains only vehicles assigned to me and is ordered by appointment time; each job card has the vehicle, services, and schedule I need. (REQ-STF-02, REQ-STF-03) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can start and finish an assigned job only with the required before-service and after-service photo evidence. (REQ-STF-04, REQ-STF-06) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can record service notes and observations for the shop and customer against the correct vehicle. (REQ-STF-05) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Assignment changes, job changes, and shop announcements are presented to me in a timely and understandable way. (REQ-STF-07, REQ-STF-08) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | My daily pending, active, and completed jobs and my completed-work history are accurate. (REQ-STF-09, REQ-STF-10) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I cannot access payments, prices, refunds, reports, customer contact details, chats, other accounts, or update another technician's vehicle. (REQ-STF-11) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

#### 1.3 Administrator account

Complete this subsection when testing with an Administrator account.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Functional suitability | The dashboard and Needs Attention list surface the current operational queue, including payment decisions, unassigned vehicles, no-shows, refunds, and completed bookings awaiting pickup. (REQ-ADM-01, REQ-ADM-02) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Booking statuses follow the correct lifecycle and prerequisites, including confirmation, completion, cancellation, no-show one hour after the appointment, and release at pickup. (REQ-ADM-03, REQ-ADM-21, REQ-SYS-10) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can assign eligible on-shift technicians within their vehicle limits, and an assignment cannot be changed after its before-service photo is uploaded. (REQ-ADM-04, REQ-SYS-04) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Payment verification displays the submitted receipt and extracted amount, reference number, and recipient for my decision; only an administrator's approval makes the payment count. (REQ-ADM-05, REQ-SYS-01, REQ-SYS-07) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can record cash and digital payments, including manual reference and amount entry when a receipt cannot be read, and the booking balance updates correctly. (REQ-ADM-06, REQ-SYS-08) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | The calendar shows appointments by technician and shop occupancy, and blocked dates or times are reflected in customer availability. (REQ-ADM-07, REQ-ADM-08, REQ-SYS-03) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Rescheduling respects capacity; cancellation records a reason and queues any eligible refund; a no-show can be reversed or rescheduled. (REQ-ADM-09, REQ-ADM-21) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Refund processing records a reason, issues a refund receipt, and updates the booking's financial record accurately. (REQ-ADM-10, REQ-SYS-08) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can create a walk-in or existing-customer booking through the booking process and add services to an open booking with any associated payment. (REQ-ADM-11, REQ-ADM-12) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Reports return the requested booking, revenue, transaction, refund, and balance information for a date range, export to PDF, and the booking assistant answers relevant booking questions. (REQ-ADM-13) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Important administrative and financial actions are recorded in the audit log with enough detail to identify the change. (REQ-ADM-14, NFR-16) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can securely invite staff or administrators and manage customer/staff accounts without removing the last administrator or a technician with active work. (REQ-ADM-15, REQ-ADM-16, REQ-NFR-34) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | The notification center alerts me to new bookings, payment uploads, and refunds; I can send customer announcements and respond to inquiries in the relevant booking thread. (REQ-ADM-17, REQ-ADM-18) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | Business Hub settings for shop details, hours, capacity, services, prices, promotions, payment policy, QR code, and terms are usable; changing the payment QR code requires email verification. (REQ-ADM-19) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Functional suitability | I can review technicians' before/after photos and service notes for the correct vehicle and booking. (REQ-ADM-20) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 2. Performance efficiency

Answer for the roles and devices you used. Measure under a normal connection; note the page, conditions, and observed time for a slow result.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Performance efficiency | Major pages load within the system's three-second target under normal internet conditions, after separating any first-request-after-idle delay. (REQ-NFR-19) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Performance efficiency | Booking and payment actions remain responsive during busy periods and repeated receipt scans do not make the system noticeably slower. (REQ-NFR-20, REQ-NFR-22) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Performance efficiency | Booking, payment, technician assignment, and status changes appear to other connected users with minimal delay. (REQ-NFR-21, REQ-SYS-05) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 3. Compatibility

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Compatibility | The pages and controls I used work in the current supported browser I tested: Chrome, Edge, or Safari. (REQ-NFR-07) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Compatibility | The layouts and essential actions remain usable on the desktop, tablet, or mobile screen sizes relevant to my role. (REQ-NFR-08, REQ-NFR-09, REQ-NFR-29) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Compatibility | The system's mobile layouts and interactions work in current Android and iOS phone browsers. (REQ-NFR-10) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Compatibility | The features I used remain usable on a standard broadband or mobile internet connection. (REQ-NFR-11) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 4. Usability

Rate only the workflows you tried; Customer and Staff experience should be evaluated on the device normally used for those tasks.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Usability | Navigation and controls make it straightforward to complete the tasks expected for my account type. (REQ-NFR-27, REQ-NFR-30) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Usability | Booking and payment require a reasonable number of clear steps, and I can tell what information or action is needed next. (REQ-NFR-28, REQ-NFR-31) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Usability | Labels, booking/payment statuses, validation messages, and error messages are understandable and help me recover from mistakes. (REQ-NFR-31) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Usability | The system asks for confirmation before consequential actions such as cancellation, refund processing, account changes, or job completion. (REQ-NFR-31) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Usability | Light and dark themes are readable, and navigation and interaction patterns are consistent across the modules I used. (REQ-NFR-30) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 5. Reliability

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Reliability | The system is available and usable during the shop's operating hours when I tested it. (REQ-NFR-23) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Reliability | After a connection interruption or refresh, saved bookings and transactions remain intact and the system does not silently lose a submitted change. (REQ-NFR-24, REQ-NFR-26) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Reliability | If a critical operation fails or is interrupted, it does not leave a partial payment, refund, booking, or added-service change. (REQ-NFR-18, REQ-NFR-26) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Reliability | After reconnecting, booking, payment, and assignment information returns to a consistent state across the screens I use. (REQ-NFR-14, REQ-NFR-21, REQ-NFR-26, REQ-SYS-05) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Reliability | Reminders, confirmations, payment decisions, receipts, and status updates are delivered once to the appropriate account when expected. (REQ-SYS-02, REQ-SYS-06) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 6. Security and data integrity

Use only your own alpha accounts and test records. Do not attempt to view another person's data.

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Security | Protected pages require sign-in, and my account can access only the features and records permitted for its role. (REQ-NFR-12, REQ-NFR-32) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Security | My account and booking information, uploaded photos, receipts, and messages are not exposed to a different test account without permission, and the browser uses a secure HTTPS connection. (REQ-NFR-12, REQ-NFR-13) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Security | Repeated failed sign-ins are limited, and sensitive account or administrative changes are restricted to authorized users. (REQ-NFR-34, REQ-NFR-35) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Data integrity | Booking totals and service prices remain consistent with the shop's catalog, and a changed browser-submitted price is not accepted. (REQ-SYS-09) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Data integrity | The system refuses a reused payment reference or receipt image and routes a below-required receipt amount for an administrator's decision. (REQ-NFR-15, REQ-SYS-07) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Data integrity | Payment, balance, credit, and refund amounts agree across booking details, billing, receipts, and reports. (REQ-SYS-08, REQ-NFR-14, REQ-NFR-17) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |
| Data integrity | Important administrative and financial changes can be traced in the audit log, and previous booking and transaction history remains available. (REQ-NFR-16, REQ-NFR-17) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

### 7. Maintainability — technical evidence (facilitator only)

These requirements describe implementation or team process and are not appropriate for an end-user opinion rating. The test lead should verify them from project or release evidence; mark **Verified**, **Not verified**, or **N/A**.

| Evidence item | Requirement(s) | Result / evidence |
|---|---|---|
| The web system is organized into independently maintainable modules. | REQ-NFR-01, NFR-05 |  |
| Supabase is used for database, sign-in, storage, and real-time updates; database changes are applied through versioned migrations. | REQ-NFR-02 |  |
| Source history is managed in GitHub and the stated Scrumban work-in-progress limit is followed. | REQ-NFR-03, REQ-NFR-04 |  |
| Business rules are maintained separately from the user interface, and key automated checks run before release. | REQ-NFR-05, REQ-NFR-06 |  |
| Authentication credentials and sign-in tokens are protected by the sign-in service, application traffic uses HTTPS, and the service's backup and recovery arrangements are confirmed by the responsible operator. | REQ-NFR-13, REQ-NFR-25, REQ-NFR-33 |  |
| Sent reminders, payment confirmations, technician assignments, and operational alerts have a retained notification record. | REQ-SYS-06 |  |

### 8. Portability

| ISO/IEC 25010 characteristic | Criteria / question | 5 | 4 | 3 | 2 | 1 | Comments / evidence | Score |
|---|---|:---:|:---:|:---:|:---:|:---:|---|:---:|
| Portability | I can access the system through a supported browser without installing a separate application. (REQ-NFR-10) | [ ] | [ ] | [ ] | [ ] | [ ] |  |  |

**Section average:** ______ / 5

## Overall evaluation

| Summary | Score / notes |
|---|---|
| Overall average of applicable, rated statements |  |
| Account type and device tested |  |
| Most successful workflow |  |
| Most important issue or blocker |  |
| Defect IDs filed |  |
| Features not tested / marked N/A |  |

## Tester comments and recommendations

______________________________________________________________________________

______________________________________________________________________________

______________________________________________________________________________
