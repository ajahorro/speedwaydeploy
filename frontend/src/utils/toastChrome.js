/**
 * toastChrome.js
 * ============================================================================
 * Toast defaults. The look of every toast comes from ONE place now: the shadcn
 * Sonner host in components/ui/sonner.jsx (themed with the shop's tokens), so no
 * call site and no module needs to carry its own colours or borders. These
 * exports stay so existing imports keep working; they only carry behaviour
 * defaults, never styling.
 * ============================================================================
 */

export const TOAST_BASE_STYLE = {};
export const TOAST_VARIANTS = {};
export const TOASTER_DEFAULTS = { duration: 4000 };
export const toastChrome = {};
