/**
 * Never let a raw JS runtime error (an actual code bug — "x.catch is not a
 * function", "Cannot read properties of undefined", etc.) reach a toast as
 * literal source-level text. A deliberately-thrown Error with a human-written
 * message (backend validation, a Postgres constraint message) still passes
 * through as-is; only JS's own built-in error types are swapped for a safe,
 * generic message.
 */
export const safeErrorMessage = (err, fallback = 'Something went wrong. Please try again.') => {
  if (err instanceof TypeError || err instanceof ReferenceError || err instanceof SyntaxError || err instanceof RangeError) {
    return fallback;
  }
  return err?.message || fallback;
};

export default safeErrorMessage;
