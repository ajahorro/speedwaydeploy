// How long a signed-in session may sit untouched before it is ended automatically.
// One place to change the numbers (per role if the shop ever wants a different limit).
export const IDLE_LIMIT_MINUTES = {
  ADMIN: 60,
  STAFF: 60,
  CUSTOMER: 60
};

// The warning (with a "Stay signed in" button) appears this many seconds before the session ends.
export const IDLE_WARNING_SECONDS = 60;

// Shared between every open tab of the same browser, so activity in one tab keeps all of them signed in.
export const LAST_ACTIVITY_KEY = 'comar-last-activity';

export const idleLimitMinutesFor = (role) => IDLE_LIMIT_MINUTES[String(role || '').toUpperCase()] ?? IDLE_LIMIT_MINUTES.CUSTOMER;
