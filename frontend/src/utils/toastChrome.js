/**
 * toastChrome.js
 * ============================================================================
 * Batch 7 / Step 7.3 — Single source of truth for toast chrome.
 *
 * Before this step the app had TWO independent toast engines:
 *   1. A bespoke stack rendered inside <UIProvider> (UIContext), hard-coded to a
 *      dark pill (#15171A) that ignored the theme.
 *   2. react-hot-toast, which had no <Toaster/> mounted until Step 7.1 — so its
 *      calls were silent no-ops.
 * The result was inconsistent styling and scattered inline overrides at call
 * sites (`{ style: { background: 'var(--admin-card)' } }` etc.).
 *
 * Both problems are now fixed by routing every toast through react-hot-toast and
 * styling it from ONE place: this module. Everything here uses native project
 * CSS tokens (var(--...)) so toasts adapt to dark/light automatically and never
 * depend on Tailwind or hard-coded colors.
 *
 * Consumers:
 *   - `main.jsx`        spreads TOASTER_DEFAULTS into <Toaster toastOptions>.
 *   - `UIContext.jsx`   uses `toastChrome` so `showToast(...)` matches.
 */

// Shared, theme-aware style. `background` uses the card token so the toast is
// legible in BOTH themes; text uses the primary text token.
export const TOAST_BASE_STYLE = {
  background: 'var(--admin-card)',
  color: 'var(--admin-text-primary)',
  border: '1px solid var(--admin-border)',
  borderRadius: 'var(--admin-radius-sm)',
  boxShadow: 'var(--admin-card-shadow)',
  fontSize: '0.85rem',
  fontWeight: 600,
  // 375px-safe: never let a long message force horizontal overflow.
  maxWidth: '92vw',
  padding: '0.6rem 0.9rem',
};

// Per-variant overrides. Kept intentionally small — only the border + icon
// colours change, so the surface stays consistent across every variant.
export const TOAST_VARIANTS = {
  success: {
    style: { border: '1px solid var(--status-success)' },
    iconTheme: { primary: 'var(--status-success)', secondary: 'var(--admin-card)' },
  },
  error: {
    style: { border: '1px solid var(--status-danger)' },
    iconTheme: { primary: 'var(--status-danger)', secondary: 'var(--admin-card)' },
  },
  warning: {
    style: { border: '1px solid var(--status-warning)' },
    iconTheme: { primary: 'var(--status-warning)', secondary: 'var(--admin-card)' },
  },
  loading: {
    style: { border: '1px solid var(--admin-border)' },
    iconTheme: { primary: 'var(--admin-text-secondary)', secondary: 'var(--admin-card)' },
  },
};

/**
 * Default options handed to react-hot-toast. `toastOptions` in <Toaster> uses
 * this shape; the per-call `toastChrome` is the same base merged for direct
 * `toast.*()` / `showToast()` calls so an inline call and the global defaults
 * can never drift apart.
 */
export const TOASTER_DEFAULTS = {
  duration: 4000,
  style: TOAST_BASE_STYLE,
  success: TOAST_VARIANTS.success,
  error: TOAST_VARIANTS.error,
  // react-hot-toast accepts a `loading` key too, but not `warning` — warnings
  // are posted via the generic `toast()` with an icon, inheriting the base.
  loading: TOAST_VARIANTS.loading,
};

/**
 * Options merged into an individual toast call. Variant-specific styling is
 * applied by react-hot-toast itself via the `success`/`error` keys in
 * TOASTER_DEFAULTS, so this only needs the shared base.
 */
export const toastChrome = {
  style: { ...TOAST_BASE_STYLE },
};