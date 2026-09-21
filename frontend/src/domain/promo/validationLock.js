/**
 * validationLock.js
 * Shared strategy engine that evaluates form state for both promo modes and
 * exposes a single `isConfirmLocked` flag (plus the first error message).
 *
 * This is the "Validation Lock Engine" from the specification: the CONFIRM
 * button stays disabled until the active mode's rules are satisfied. Adding a
 * new promo mode later means registering one strategy object, not editing UI.
 */
import { PROMO_MODE } from './promoTypes';
import { validateStandardPromo } from './standardPromo';
import { validatePackagePromo } from './packagePromo';

/**
 * Strategy registry keyed by promo mode. Each strategy maps a draft (+ context)
 * to { valid, errors } and never throws on partial drafts.
 */
const VALIDATION_STRATEGIES = Object.freeze({
  [PROMO_MODE.STANDARD]: (draft) => validateStandardPromo(draft),
  [PROMO_MODE.PACKAGE]: (draft, context) => validatePackagePromo(draft, context),
});

/**
 * Evaluate a promo draft and return the lock state for the confirm action.
 * @param {object} draft - the current promo draft (must carry `mode`).
 * @param {object} context - optional resolver context (e.g. { resolvePrice, servicePrices }).
 * @returns {{ valid:boolean, isConfirmLocked:boolean, errors:string[], firstError:string, meta:object }}
 */
export const evaluatePromoLock = (draft = {}, context = {}) => {
  const strategy = VALIDATION_STRATEGIES[draft.mode] || VALIDATION_STRATEGIES[PROMO_MODE.STANDARD];
  const result = strategy(draft, context) || { valid: false, errors: [] };
  const errors = result.errors || [];
  return {
    valid: Boolean(result.valid),
    isConfirmLocked: errors.length > 0,
    errors,
    firstError: errors[0] || '',
    meta: {
      minimumStandalone: result.minimumStandalone,
      bundleCount: result.bundleCount,
    },
  };
};

/** Convenience predicate matching the spec's boolean flag contract. */
export const isConfirmLocked = (draft, context = {}) => evaluatePromoLock(draft, context).isConfirmLocked;
