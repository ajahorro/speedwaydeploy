# RESULTS AND DISCUSSION

Anything in [square brackets] depends on the testers and respondents. Fill it in after testing. "Table __" and "Figure __" are numbered when the chapter is assembled.

## Testing

The testing phase for the prototype of the Comar Garage Online Appointment and Scheduling Management System was conducted to make sure that the system's functions, performance, and user experience were ready before deployment. Both alpha testing and beta testing were used to evaluate the Administrator, Staff, and Customer sides of the system.

In the alpha testing, [number] IT professionals were invited to assess the system using structured questionnaires. On the Administrator side, the evaluation focused on sign-in security and automatic sign-out, booking management, payment verification, refunds, technician assignment, reports, the audit log, and the Business Hub settings. On the Staff side, the evaluation covered sign-in, clocking in and out, viewing assigned vehicles, starting and finishing jobs, and uploading service photos. On the Customer side, the assessment covered navigation, booking one or more vehicles, payment and receipt upload, booking tracking, rescheduling, cancelling, adding services, notifications, and chat. [Summarize the main feedback and suggestions of the alpha testers.]

Following the alpha testing, beta testing was conducted on the three sides of the system. On the Administrator side, [number] administrator(s) were purposively selected to test the system in an actual working environment, focusing on booking management, payment verification, and overall usability. On the Staff side, [number] staff member(s) tested the daily job workflow. On the Customer side, the beta testing involved [number] respondents who had booked an auto care service, visited a garage website, were planning to book a service, or were interested in auto care services. Their participation aimed to evaluate the convenience of the booking process, the responsiveness of the system, and the clarity of the payment and booking details.

[Summarize what the testing showed, which issues were fixed, and whether the system is ready for deployment.]

## Description of Prototype

The system prototype of the Comar Garage Online Appointment and Scheduling Management System integrated the system requirements and the client's needs in its design. It is one web application with three separate portals for the Customer, the Staff, and the Administrator, so that each user sees only what their role needs.

Customers can book one or more vehicles in a single booking, choose services, apply a promo code, pay a downpayment or the full amount by cash, GCash, or bank transfer, upload their receipt, and follow the progress of each vehicle. They can also reschedule, cancel, add a service, chat with the shop, and receive email and in-app notices. Staff see only the vehicles assigned to them, clock in and out, start and finish jobs, and upload before and after photos. The Administrator manages bookings, assigns a technician to each vehicle, verifies payments, processes refunds, reads reports, reviews the audit log, manages staff accounts, and sets the shop's rules in the Business Hub. The system reads uploaded receipts automatically, and the Administrator makes the final check.

While the system prototype is functional with its intended features, [feedback from the alpha testers on the interface and system flow was integrated to further refine and improve the system].

[Figure __. Before Alpha Testing - (name of the screen)]

[Figure __. After Alpha Testing - (name of the screen)]

[Describe the feedback that was integrated and what was changed, as shown in the two figures.]

## Implementation Plan

The implementation of the system starts with online deployment, installation, and the transition to a working online system. Automating and streamlining the shop's operations are the key objectives of the system. Its key features are online self-booking for several vehicles, payment verification with automatic receipt reading, technician assignment, service tracking with photos, notifications, and reports with an audit log.

The implementation begins with making sure the system is available to customers, staff, and the administrator through the internet. The Vercel and Render platforms are used for web hosting, and Supabase is used for the database, sign-in, and file storage. The system is linked to the domain comargarage.com, configured, and checked for stability and consistency on different devices for all three portals. The Resend email service is set up and tested so that customers receive booking confirmations, receipts, reminders, and other notices at their email address. The scheduled checks, such as releasing unpaid holds, flagging no-shows, and the inactive-staff check, are also confirmed to be running.

After the technical deployment, the administrator and staff are trained in using the system. The administrator's training focuses on booking management, payment verification, refunds, technician assignment, reports, and the Business Hub. The staff's training focuses on clocking in and out, viewing assigned vehicles, and uploading service photos. The goal of this phase is to make sure that everyone is familiar with the features and uses of the system.

The implementation requires computers to manage the system and mobile devices to check that it works on different platforms. Services such as Vercel, Render, Supabase, and Resend are needed for web hosting, data storage, and email. The system also requires a stable internet connection on every device used.

This plan ensures a smooth move of the system from local development to the web, with each platform set up and tested for functionality and reliability throughout the implementation.

## Implementation Results

This section presents the outcomes of the Alpha and Beta Testing for the Administrator, Staff, and Customer sides of the Comar Garage Online Appointment and Scheduling Management System. The results are shown through figures and tables that illustrate the system's functionality, performance, and user satisfaction. The succeeding figures and tables summarize the findings of each test.

### Alpha Test Results

#### Alpha Test Results for Administrator Side

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Were you able to sign in successfully using the sign-in page? | | | | | |
| 2 | Can you change your password and sign in again using the new password without errors? | | | | | |
| 3 | Does the system lock the account after repeated wrong passwords, and does it tell you how to recover? | | | | | |
| 4 | Does the system warn you and then sign you out automatically after a period of no activity? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Security Evaluation (Administrator Side)

[Table __ presents the results of the Security Evaluation on the Administrator Side. Discuss the satisfaction rate and what it shows.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Can you create a walk-in booking for a guest or an existing customer, with several vehicles? | | | | | |
| 2 | Can you add a service to an existing booking and record its payment? | | | | | |
| 3 | Can you assign a separate technician to each vehicle of a booking? | | | | | |
| 4 | Can you invite a new staff member and see the invitation work? | | | | | |
| 5 | Can you reschedule or cancel a booking correctly? | | | | | |
| 6 | Can you change a setting in the Business Hub (hours, a service, or a promo) and see it apply to new bookings? | | | | | |
| 7 | Can you start a booking for a customer from the chat and see the customer's details arrive? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. System Functionality Testing (Administrator Side)

[Table __ highlights the results of the System Functionality Testing on the Administrator Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Does the dashboard load completely within 2 to 3 seconds after signing in? | | | | | |
| 2 | Is the system responsive for standard actions (within about 2 to 3 seconds)? | | | | | |
| 3 | Does the receipt reading show its result within a reasonable time? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Performance Testing (Administrator Side)

[Table __ presents the results of the Performance Testing on the Administrator Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Does the system refuse a booking when the shop is full, closed, or the time is blocked? | | | | | |
| 2 | Does the receipt reading show the correct amount and reference number from a clear receipt? | | | | | |
| 3 | Does a verified payment update the balance and the booking status correctly (for example, a verified downpayment confirming the booking)? | | | | | |
| 4 | Does a refund show correctly and produce a refund receipt? | | | | | |
| 5 | Do the daily and date-range reports match the recorded payments? | | | | | |
| 6 | Does the audit log record the actions you performed? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Reliability and Accuracy Testing (Administrator Side)

[Table __ presents the results of the Reliability and Accuracy Testing on the Administrator Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Can you reach the main modules from the sidebar? | | | | | |
| 2 | Are input fields checked, with clear error messages (for example, rejecting incomplete or incorrect details)? | | | | | |
| 3 | Do confirmation pop-ups appear before important actions (cancelling, refunding, or changing)? | | | | | |
| 4 | Is the wording on the screens clear and easy to understand? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Usability and Validation Testing (Administrator Side)

[Table __ presents the results of the Usability and Validation Testing on the Administrator Side. Discuss.]

#### Alpha Test Results for Staff Side

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Were you able to sign in and change your password at first sign-in? | | | | | |
| 2 | Can you clock in and clock out? | | | | | |
| 3 | Do you see only the vehicles assigned to you? | | | | | |
| 4 | Can you start a job by uploading a before-service photo? | | | | | |
| 5 | Can you finish a job by uploading an after-service photo and writing service notes? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. System Functionality Testing (Staff Side)

[Table __ highlights the results of the System Functionality Testing on the Staff Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Does your list of vehicles load quickly on a phone? | | | | | |
| 2 | Does a photo upload finish within a reasonable time? | | | | | |
| 3 | Can you not see other staff members' vehicles, payments, or accounts? | | | | | |
| 4 | Does a status you change appear for the customer and the administrator? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Performance, Reliability, and Access Testing (Staff Side)

[Table __ presents the results of the Performance, Reliability, and Access Testing on the Staff Side. Discuss.]

#### Alpha Test Results for Customer Side

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Can you register, activate your account, and sign in? | | | | | |
| 2 | Can you book more than one vehicle, with services, in a single booking? | | | | | |
| 3 | Does the calendar show only the times that can be booked? | | | | | |
| 4 | Can you pay the required downpayment by uploading a GCash or bank receipt? | | | | | |
| 5 | Can you follow the progress of each vehicle and see the service photos? | | | | | |
| 6 | Can you reschedule, cancel, or add a service to your booking? | | | | | |
| 7 | Can you chat with the shop and receive notifications and emails? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Functionality Testing (Customer Side)

[Table __ presents the results of the Functionality Testing on the Customer Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Is the website responsive on both phone and computer? | | | | | |
| 2 | Do pages load and respond within a reasonable time? | | | | | |
| 3 | Does the receipt upload and reading finish within a reasonable time? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Performance Testing (Customer Side)

[Table __ presents the results of the Performance Testing on the Customer Side. Discuss.]

| # | Question | Tester 1 | Tester 2 | Tester 3 | Total: Yes | Total: No |
|---|---|---|---|---|---|---|
| 1 | Are input fields checked, with clear error messages? | | | | | |
| 2 | Are the booking steps easy to follow? | | | | | |
| 3 | Do you receive clear payment and booking details after booking? | | | | | |
| | Overall Mean | | | | | |
| | Overall Satisfaction Rate (%) | | | | | |

Table __. Usability and Validation Testing (Customer Side)

[Table __ presents the results of the Usability and Validation Testing on the Customer Side. Discuss.]

### Alpha Test Evaluation

**Administrator Side --** [Based on the alpha test data in the tables above, describe what the testers could do without trouble, which issues were found, and which were fixed.]

**Staff Side --** [Describe the alpha findings for the Staff side.]

**Customer Side --** [Describe the alpha findings for the Customer side, including feedback that was changed in the system.]

### Beta Test Results for Administrator Side

The beta testing for the Administrator side was conducted by purposively selecting [number] administrator(s) as respondent(s). The evaluation was facilitated through [Google Forms]. The purpose of this beta testing was to evaluate the usability, functionality, and suitability of the Administrator side of the system. It aimed to determine whether the features effectively support the administrator's daily tasks. Open questions were used to gather detailed feedback, comments, and suggestions.

[Figure __. Administrator's Experience Signing In and Changing Passwords]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Feedback on Dashboard Performance]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Creating Bookings and Adding Services]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Assigning Technicians to Each Vehicle]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Verifying Payments and Reading Receipts]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Handling Cancellations and Refunds]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Using Reports and the Audit Log]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Experience Changing Settings in the Business Hub]

Figure __ shows [the administrator's response and what it means].

[Figure __. Administrator's Overall Impressions and Recommendations on the System]

Figure __ shows [the administrator's overall impression and any suggestions].

### Beta Test Results for Staff Side

[Add this section if staff members test the system. The beta testing for the Staff side was conducted by [number] staff member(s). Describe the method, then present one figure for each question, such as signing in, clocking in and out, viewing assigned vehicles, starting and finishing jobs with photos, and overall impressions.]

### Beta Test Results for Customer

A user experience evaluation was conducted and administered using [Google Forms] and distributed online to gain insight into the experience and preferences of customers and potential customers of auto care services.

Based on the interview with the client, the number of customers of Comar Garage is approximately [N]. Using Slovin's formula with a margin of error of 0.05:

n = N / (1 + Ne²)

where n = sample size, N = population size, and e = acceptable margin of error. We calculated a sample size of [n] respondents to reflect the preferences and experience of the customers of the shop.

| | Frequency (N = ___) | Percent (%) |
|---|---|---|
| **Age** | | |
| 18 - 24 | | |
| 25 - 34 | | |
| 35 - 44 | | |
| 45 and above | | |
| **Type of Vehicle Owned** | | |
| Car (sedan, SUV, van) | | |
| Motorcycle or big bike | | |
| Both car and motorcycle | | |
| **Online Garage Booking and Website Visit Experience** | | |
| Booked a garage service online only | | |
| Visited a garage's website only | | |
| Both booked and visited online | | |
| Neither booked nor visited online | | |
| **Preferred Booking Method** | | |
| Garage's official website or booking system | | |
| Walk-in (in person) | | |
| Phone call or text | | |
| Social media (e.g., Facebook, Messenger) | | |
| No specific preference | | |
| **Preferred Payment Method** | | |
| Cash at the shop | | |
| GCash or other e-wallet | | |
| Bank transfer | | |
| No specific preference | | |
| **Website Visit Frequency Before Booking** | | |
| Never | | |
| Sometimes | | |
| Often | | |
| Always | | |

Table __. Respondents' Profile and Online Booking Behavior

[Table __ provides an overview of the respondents' backgrounds and online booking behavior. Describe the age groups, vehicle types, online booking experience, and preferred booking and payment methods.]

| Statement | Strongly Agree | Agree | Disagree | Strongly Disagree |
|---|---|---|---|---|
| 1. It was easy to find the services and prices I needed on the website. | | | | |
| 2. The booking steps (vehicles and services, date and time, payment) were easy to follow. | | | | |
| 3. Booking more than one vehicle in a single booking was easy. | | | | |
| 4. The calendar and available times made it easy to choose my preferred schedule. | | | | |
| 5. Uploading my payment receipt was simple and the instructions were clear. | | | | |
| 6. I could easily see the status and progress of my booking and my vehicle(s). | | | | |
| 7. The notifications and emails I received were clear and helpful. | | | | |
| 8. I could easily reschedule, cancel, or add a service to my booking. | | | | |
| 9. The website was fast and smooth while I was browsing and booking. | | | | |
| 10. The website clearly showed me when I entered incomplete or incorrect details. | | | | |
| 11. Based on my experience, I would recommend this website for booking auto care services. | | | | |

Table __. Survey Results from Beta Testing (Customer Side)

[Figure __. Survey Result on Ease of Finding Services and Prices]

Figure __ shows that [number] respondents ([%]) strongly agreed, [number] ([%]) agreed, [number] ([%]) disagreed, and [number] ([%]) strongly disagreed that [statement]. [What the result suggests.]

[Repeat the figure and the paragraph for statements 2 to 11, with the figure titles: Survey Result on Ease of Following the Booking Steps; Survey Result on Booking Several Vehicles; Survey Result on Calendar and Available Time Clarity; Survey Result on Ease of Uploading the Payment Receipt; Survey Result on Seeing Booking Progress; Survey Result on Notifications and Emails; Survey Result on Rescheduling, Cancelling, and Adding Services; Survey Result on Website Speed and Smoothness; Survey Result on Form Validation Clarity; Survey Result on Website Recommendation.]

### Beta Test Evaluation

**Administrator Side --** [Summarize the administrator's satisfaction, the features praised, and any minor feedback.]

**Customer Side --** [Summarize the respondents' satisfaction, the features praised, and any concerns such as speed.]

### Alpha and Beta Test Summary

[Summarize how both tests improved the prototype, whether the testers were satisfied, the issues found and fixed on the Administrator, Staff, and Customer sides, and whether the results confirm that the system benefits the shop and its customers.]

---

# CONCLUSION

## Summary

The development of the Comar Garage Online Appointment and Scheduling Management System was evaluated through alpha and beta testing. On the Administrator side, [IT professionals and the administrator confirmed that features such as sign-in security, booking management, technician assignment, payment verification, refunds, reports, the audit log, and the Business Hub were functional and reliable]. [Minor issues that were noted and resolved.]

On the Staff side, [the testers confirmed that clocking in and out, viewing assigned vehicles, and uploading service photos worked as intended]. On the Customer side, both alpha and beta tests [highlighted the usability of the website, particularly in booking several vehicles, paying with a receipt upload, and following the progress of the service]. [Summarize the customers' feedback.]

Overall, the results show that the system [effectively supports the shop's operations while giving customers a reliable and easy way to book and pay].

## Conclusions

The development of the Comar Garage Online Appointment and Scheduling Management System was evaluated through alpha and beta testing. The findings [confirm] that the system meets its general objective of providing a web-based platform that automates the service process for the Administrator, Staff, and Customers of Comar Garage. [State how it reduced data fragmentation and manual transcription errors by keeping bookings, payments, service records, and communication in one place.]

### Relation of Specific Objectives to Test Results

1. To develop a Fleet Booking module that enables users to book and configure multiple vehicles, with their services, within a single session.

   [The alpha test showed that ... The beta test showed that customers and the administrator could book several vehicles and add services ... This confirms that the objective was met.]

2. To implement an Intelligent Capacity Allocation module that validates every appointment against the shop's live capacity.

   [The alpha test showed that the system refused bookings outside shop hours, on closed days, in blocked times, or beyond capacity ... This confirms that the objective was met.]

3. To develop a Technician Assignment and Workload Control module that assigns technicians to each vehicle based on availability and current workload.

   [The alpha and beta tests showed that the administrator could assign a separate technician to each vehicle, that the workload limit was respected, and that staff saw only their own vehicles ... This confirms that the objective was met.]

4. To integrate an OCR module within a Dual-Verification Payment Hub that validates digital payment records.

   [The alpha and beta tests showed that uploaded receipts were read and checked and that the administrator made the final verification ... This confirms that the objective was met.]

5. To design a dedicated Financial and Audit section that monitors refunds and business growth through structured reports and a transparent audit trail.

   [The tests showed that refunds, reports, and the audit log worked and matched the recorded payments ... This confirms that the objective was met.]

6. To establish an Automated Notification and Reminder System that keeps customers informed through email and in-app messages.

   [The tests showed that confirmation, payment, assignment, and completion notices and reminders were received ... This confirms that the objective was met.]

7. To feature a Unified Booking Chat and Evidence Record that gathers payment proofs, service photos, and messages in one place.

   [The tests showed that messages, payment proofs, and service photos were kept together with each booking ... This confirms that the objective was met.]

## Recommendations

Based on the study and the development of the Comar Garage Online Appointment and Scheduling Management System, the following recommendations are proposed for future researchers and developers:

1. Automatic Payment Confirmation - The system reads each receipt automatically, but the administrator must still verify every payment. Connecting the system to a payment provider would confirm payments automatically and reduce the administrator's workload.

2. More Payment Options - The system supports cash, GCash, and bank transfer. Adding other e-wallets and card payments would give customers more choices and make paying more convenient.

3. Suggested Technician Assignment - The administrator assigns technicians by hand, with a limit on each technician's workload. A future version could suggest the best technician based on availability, workload, and skills, while still leaving the final choice to the administrator.

4. Text Message Notifications - Customers are notified by email and in the system. Adding text messages would reach customers who rarely check their email and further reduce no-shows.

5. In-depth Reports - More detailed charts and data, such as customer groups, the most requested services, and busy periods, would help the shop plan its schedule, staffing, and promotions.

6. Mobile App and Offline Support - An installable mobile app for staff, with limited offline use that syncs when the connection returns, would help in areas with weak internet.

7. Inquiry and Contact Features - A working contact form and online inquiry on the shop's public page would let new customers reach the shop before they create an account.

8. Hosting and Testing Environment - Using a higher hosting plan and a separate testing copy of the system would improve speed and make updates safer to release.

---

# REFERENCES

Fill in the source details for each entry (publisher or journal, volume, pages, and link) in the same style as the rest of your references. Entries are in alphabetical order.

Abella, et al. (2023). Factors affecting customer satisfaction on mobile money services in the Philippines. [Source].

Adha, et al. (2022). BOOK4WASH: Mobile car wash booking system. [Source].

Ampuan, & Delena. (2022). An implementation and evaluation of a web-based appointment system for Mindanao State University. [Source].

Bradač Hojnik, et al. (2023). Small and medium-sized enterprises in the digital age: Understanding digitalization characteristics and demands. [Source].

Department of Trade and Industry. (2024). Micro, small, and medium enterprise development plan. [Source].

Dreimann, et al. (2023). Empirical studies on booking status and customer choice behavior in online appointment systems. [Source].

Fortune Business Insights. (2023). Appointment scheduling software market. [Source].

Garavand, et al. (2025). Stakeholders' experiences, perceptions, and satisfaction with an electronic appointment system. [Source].

Gumasing, et al. (2023). A comparison on the usability of mobile e-wallet applications: GCash, Maya, GrabPay. [Source].

[Author]. (2023). E-payment system readiness of micro business owners in the Philippines. Journal of Social Entrepreneurship Theory and Practice.

[Author]. (2023). Digital payment transformation in the Philippines: From cash to GCash. [Source].

[Author]. (2022). MSMEs and digital tool use in the Philippines. [Source].

[Author]. (2022). Online appointment management system: User behavior and technology acceptance in the Philippine context. [Source].

Kraus, et al. (2022). Digital transformation and innovation in small and medium enterprises. [Source].

Kumar, et al. (2022). Online service booking platform with payment integration. [Source].

Maulana, & Adha. (2024). Optimizing car wash services with a web-based ordering system. [Source].

Ngo, et al. (2022). Toward SMEs digital transformation success: A systematic literature review. [Source].

Prado, et al. (2025). Fixera: A geo-located mobile application for convenient auto fix locator. [Source].

University of the Philippines Institute for Small-Scale Industries. (2024). Empowering Philippine MSMEs through digital transformation. [Source].

Zygiaris, et al. (2022). Service quality and customer satisfaction in the auto care industry. [Source].

[Add the sources used in the Technical Background and Requirements Analysis, such as the device and browser requirements and the technology documentation.]

---

# APPENDICES

APPENDIX A. Resource Persons (the alpha testers, the client or shop owner, and the beta testers: name, position, and office)

APPENDIX B. Gantt Chart (the project calendar of activities)

APPENDIX C. Developer's Photos and Client Documents

APPENDIX D. Transcript of Interview (with the client or shop owner)

APPENDIX E. Evaluation Tool and Test Documents
- Comar Garage Alpha Test (Administrator Side)
- Comar Garage Alpha Test (Staff Side)
- Comar Garage Alpha Test (Customer Side)
- Beta Test Questionnaire (Administrator Side)
- Beta Test Questionnaire (Staff Side)
- Beta Test Questionnaire (Customer Side)
- Beta Testing Phase Notification Screen

APPENDIX F. Alpha and Beta Testers' Communications and Agreements

APPENDIX G. Thesis Expense

APPENDIX H. Terms and Conditions and Privacy Policy of the System (the terms the system shows to customers, staff, and administrators)

APPENDIX I. Photos from Survey and Testing

APPENDIX J. Alpha Tester's Curriculum Vitae

APPENDIX K. Personal Technical Vitae

APPENDIX L. Relevant Source Code
