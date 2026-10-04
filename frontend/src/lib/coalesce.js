/**
 * Collapse a burst of realtime events into one trailing call.
 *
 * One business action (verify a payment, change a status) writes several rows,
 * so a screen subscribed to bookings, payments and vehicles used to refetch once
 * per row. The returned function can be called as often as events arrive; `fn`
 * runs once, `wait` ms after the last call. `.cancel()` drops a pending run
 * (call it in effect cleanup).
 */
export const createCoalescer = (fn, wait = 350) => {
  let timer = null;
  const run = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, wait);
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return run;
};
