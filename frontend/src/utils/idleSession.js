/**
 * The timing rule for the automatic sign-out, kept free of the screen so it can be tested.
 *
 *   idle for less than (limit - warning)  -> 'active'
 *   idle for (limit - warning) or more    -> 'warning'  (with the seconds left)
 *   idle for the limit or more            -> 'expired'
 *
 * A device that was asleep for longer than the limit comes back as 'expired' straight away, with no warning.
 *
 * @param {number} now             current time, in milliseconds
 * @param {number} lastActivity    time of the last click, key press, scroll or touch, in milliseconds
 * @param {number} limitMs         idle time allowed before sign-out
 * @param {number} warningMs       how long before the end the warning starts
 */
export const idleState = (now, lastActivity, limitMs, warningMs) => {
  const last = Number.isFinite(lastActivity) && lastActivity > 0 ? lastActivity : now;
  const idle = Math.max(0, now - last);
  if (idle >= limitMs) return { state: 'expired', secondsLeft: 0 };
  if (idle >= limitMs - warningMs) return { state: 'warning', secondsLeft: Math.max(1, Math.ceil((limitMs - idle) / 1000)) };
  return { state: 'active', secondsLeft: Math.ceil((limitMs - idle) / 1000) };
};
