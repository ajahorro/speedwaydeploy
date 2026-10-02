import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(path, 'utf8');
const themeToggle = read('frontend/src/components/ThemeToggle.jsx');
const preferences = read('frontend/src/components/Settings/AppPreferencesCard.jsx');
const responsiveStyles = read('frontend/src/index.css');
const bookingChat = read('frontend/src/components/BookingChat.jsx');
const scheduleGrid = read('frontend/src/pages/Admin/AdminSchedulingGrid.jsx');
const bookings = read('frontend/src/pages/Admin/AdminBookings.jsx');
const bookingDetails = read('frontend/src/pages/Admin/AdminBookingDetails.jsx');

const checks = [
  ['mobile theme selectors omit System while preserving effective current theme', /OPTIONS\.filter\(\(option\) => option\.value !== 'system'\)/.test(themeToggle) && /THEME_OPTIONS\.filter\(\(option\) => option\.value !== 'system'\)/.test(preferences) && /theme === 'system' \? resolvedTheme : theme/.test(themeToggle) && /repeat\(\$\{options\.length\}/.test(themeToggle)],
  ['mobile text controls prevent iOS focus zoom', /@media \(max-width: 768px\)[\s\S]*?font-size: 16px !important/.test(responsiveStyles)],
  ['admin and customer mobile search rows fit available width', /portal-search-row > \.portal-search-control[\s\S]*?width: 100% !important/.test(responsiveStyles) && /className="portal-search-input"/.test(read('frontend/src/components/AdminSearch.jsx')) && /className="portal-search-input"/.test(read('frontend/src/components/CustomerSearch.jsx'))],
  ['chat composer uses shared mobile input sizing', /className="chat-message-input"/.test(bookingChat) && /textarea[\s\S]*?font-size: 16px !important/.test(responsiveStyles)],
  ['hourly schedule row labels use the active theme text color', /isUnassigned \? 'var\(--admin-brand\)' : 'var\(--admin-text-primary\)'/.test(scheduleGrid)],
  ['mobile schedule uses a chronological appointment list instead of a wide grid', /isMobile \? \([\s\S]*?bookings[\s\S]*?start_datetime[\s\S]*?navigate\(`\/admin\/bookings\/\$\{booking\.id\}`\)/.test(scheduleGrid) && /: \(\s*<div style=\{\{ background: 'var\(--admin-card\)'[\s\S]*?minWidth: '1200px'/.test(scheduleGrid)],
  ['booking cards collapse safely on narrow screens and empty-state text respects theme', /booking-directory-card-meta/.test(bookings) && /rgba\(255,255,255,0\.2\)/.test(bookings) === false && /\.booking-directory-card-meta\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/.test(responsiveStyles)],
  ['booking customer summary is hidden on mobile while detail contact remains available', /BookingSummaryHeader booking=\{booking\} showCustomer=\{!isMobile\}/.test(bookingDetails) && /Registered Contact/.test(bookingDetails)],
  ['mobile reschedule modal fits dynamic viewport and stacks actions', /maxHeight: 'min\(90vh, calc\(100dvh - 1rem\)\)'/.test(bookingDetails) && /flexDirection: isMobile \? 'column-reverse' : 'row'/.test(bookingDetails)],
  ['undo no-show modal uses theme-aware overlay and square control tokens', /background: 'var\(--modal-overlay\)'/.test(bookingDetails) && /borderRadius: 'var\(--admin-radius-sm\)'/.test(bookingDetails)]
];

for (const [name, passed] of checks) {
  assert.ok(passed, name);
  console.log(`PASS  ${name}`);
}

console.log(`\n${checks.length} mobile usability checks passed.`);
