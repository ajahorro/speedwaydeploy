/**
 * toastManager.js
 * ============================================================================
 * ONE gate through which every toast in the app passes.
 *
 * THE DEFECT THIS EXISTS TO FIX
 * -----------------------------
 * A single walk-in booking submit produced THREE toasts at the same instant,
 * from three unrelated parts of the code:
 *
 *   1. "Booking submitted successfully!"      — CustomerBookAppointment (wizard)
 *   2. "Walk-in booking created and confirmed."— AdminWalkInWizard (admin flow)
 *   3. "jamesvillanueva119 booked a service…" — AdminLayout Realtime listener
 *
 * Because they originate in different modules, no call-site rule can coordinate
 * them: each one legitimately believes it is the only one notifying. react-hot-toast
 * happily renders all three, stacked on top of each other — and because the
 * Realtime alert is positioned `top-right` with a long 8s duration, it painted
 * OVER primary-action modals (e.g. the Official Receipt) that the user was
 * actively reading.
 *
 * THE MODEL
 * ---------
 *   • DEDUPE   — an identical message that is already live is NOT re-spawned.
 *                The existing toast's timer is refreshed instead, so a repeat
 *                reads as "still true", never as a second identical card.
 *   • CAP      — at most MAX_VISIBLE toasts may be on screen. When a new one
 *                arrives at the cap, the OLDEST is dismissed to make room. This
 *                is a hard ceiling, not a hint: the three-toast burst becomes
 *                at most two, and the newest (the one that just happened) wins.
 *   • PRIORITY — a `background` toast (Realtime/ambient) is suppressed while any
 *                modal is open, so a background booking alert can never steal
 *                focus or cover the receipt. Foreground toasts (direct results
 *                of the user's own click) still show, because the user is
 *                waiting for them.
 *
 * All three rules live HERE rather than at call sites, because the whole problem
 * was that call sites cannot see each other.
 *
 * WHY THE RULES ARE A SEPARATE FACTORY
 * ------------------------------------
 * `createToastQueue(engine)` contains every decision and touches no global. That
 * makes the rules directly testable with a stub engine, instead of requiring a
 * module-resolution hack to intercept `react-hot-toast` (an ES `import` of a CJS
 * package is NOT interceptable via `Module._load`, so the obvious stubbing trick
 * silently fails and a test built on it would pass while proving nothing).
 * ============================================================================
 */

import reactHotToast from '@/lib/toast';

/** Hard ceiling on simultaneously visible toasts. */
export const MAX_VISIBLE = 2;

/** Default visible duration, matching TOASTER_DEFAULTS. */
const DEFAULT_DURATION = 4000;

/**
 * Stable key for dedupe: same kind + same message means "the same toast".
 *
 * Returns null when no stable key exists (a render-function message), which
 * makes that toast un-dedupable unless the caller supplies an explicit
 * `dedupeKey`. Stringifying a function would compare its SOURCE — identical for
 * every booking alert — and wrongly collapse distinct alerts into one.
 */
const keyOf = (kind, message) => {
  if (typeof message === 'function') return null;
  return `${kind}::${String(message ?? '').trim().toLowerCase()}`;
};

/**
 * Build the rule engine around a toast `engine` (react-hot-toast in production,
 * a recording stub in tests). The engine only needs: `success`, `error`,
 * `loading`, `default`, and `dismiss`.
 *
 * @param {object} engine
 * @returns {object} the queue API
 */
export const createToastQueue = (engine) => {
  /** Live toasts, oldest first: `{ id, key, message, kind, background }`. */
  const live = [];

  /** Count of OPEN modals; a counter because modals can nest. */
  let openModalCount = 0;

  const forget = (id) => {
    const index = live.findIndex((entry) => entry.id === id);
    if (index !== -1) live.splice(index, 1);
  };

  /**
   * Evict the oldest toast(s) until there is room for one more.
   *
   * WHY OLDEST-FIRST: in the reported burst the three toasts are ordered by how
   * long ago they happened. The newest is the most relevant ("your booking went
   * through"), so the oldest is the correct one to sacrifice.
   */
  const enforceCap = () => {
    while (live.length >= MAX_VISIBLE) {
      const oldest = live.shift();
      if (!oldest) break;
      engine.dismiss(oldest.id);
    }
  };

  /** Render via the correct variant for `kind`. */
  const emit = (kind, message, options) => {
    switch (kind) {
      case 'error': return engine.error(message, options);
      case 'loading': return engine.loading(message, options);
      case 'warning': return engine.warning ? engine.warning(message, options) : engine.default(message, { ...options, icon: '⚠️' });
      case 'info': return engine.info ? engine.info(message, options) : engine.default(message, { ...options, icon: 'ℹ️' });
      case 'success': return engine.success(message, options);
      default: return engine.default(message, options);
    }
  };

  /**
   * The single spawn path. `kind` selects the variant; `background` marks an
   * ambient (non-user-initiated) toast.
   */
  const spawn = (kind, message, options = {}) => {
    const { id: explicitId, background = false, duration, dedupeKey, ...rest } = options;

    // ── RULE 3: background toasts never render over a modal ────────────────
    if (background && openModalCount > 0) return null;

    const key = dedupeKey ? `${kind}::${dedupeKey}` : keyOf(kind, message);
    const existing = key ? live.find((entry) => entry.key === key) : null;

    // ── RULE 1: an identical live toast is refreshed, never duplicated ─────
    if (existing) {
      // Re-emitting the same id restarts the duration without a second card.
      emit(kind, message, { ...rest, id: existing.id, duration: duration ?? DEFAULT_DURATION });
      return existing.id;
    }

    // ── RULE 2: make room before adding ────────────────────────────────────
    enforceCap();

    const callOptions = { ...rest };
    if (duration !== undefined) callOptions.duration = duration;

    const id = explicitId ?? emit(kind, message, callOptions);
    live.push({ id, key, message, kind, background });

    // The toast may leave early (user click / timeout / dismissAll). This guard
    // covers a dismiss issued directly against the engine elsewhere. `isActive`
    // is optional — react-hot-toast v2.4.1 does not export it — so its absence
    // must not throw inside a timer (an unhandled throw there would be an
    // invisible production error).
    setTimeout(() => {
      const stillActive = typeof engine.isActive === 'function' ? engine.isActive(id) : false;
      if (!stillActive) forget(id);
    }, (duration ?? DEFAULT_DURATION) + 250);

    return id;
  };

  const queue = {
    spawn,
    success: (message, options) => spawn('success', message, options),
    error: (message, options) => spawn('error', message, options),
    warning: (message, options) => spawn('warning', message, options),
    info: (message, options) => spawn('info', message, options),
    loading: (message, options) => spawn('loading', message, options),
    /** Ambient toast — Realtime alerts and anything the user did not trigger. */
    background: (message, options = {}) => spawn(options.kind || 'default', message, { ...options, background: true }),

    dismiss: (id) => {
      if (id === undefined) {
        live.length = 0;
        return engine.dismiss();
      }
      forget(id);
      return engine.dismiss(id);
    },

    dismissAll: () => {
      live.length = 0;
      return engine.dismiss();
    },

    notifyModalOpened: () => {
      openModalCount += 1;
      // Anything already on screen would cover the modal the user just opened.
      queue.dismissAll();
    },

    notifyModalClosed: () => {
      openModalCount = Math.max(0, openModalCount - 1);
    },

    /** Test/introspection helper — the current visible set, oldest first. */
    __live: () => live.map((entry) => ({ ...entry })),
    __openModalCount: () => openModalCount,
  };

  return queue;
};

/**
 * Production engine adapter over the app toast (lib/toast.js, shadcn Sonner).
 *
 * `isActive` is attached only when the library actually exports it: the queue
 * treats a missing `isActive` as "assume gone", which affects bookkeeping
 * cleanup only, never what the user sees.
 */
const reactHotToastEngine = {
  success: (message, options) => reactHotToast.success(message, options),
  error: (message, options) => reactHotToast.error(message, options),
  loading: (message, options) => reactHotToast.loading(message, options),
  warning: (message, options) => reactHotToast.warning(message, options),
  info: (message, options) => reactHotToast.info(message, options),
  default: (message, options) => reactHotToast(message, options),
  dismiss: (id) => (id === undefined ? reactHotToast.dismiss() : reactHotToast.dismiss(id)),
};
if (typeof reactHotToast.isActive === 'function') {
  reactHotToastEngine.isActive = (id) => reactHotToast.isActive(id);
}

/**
 * Public API — a drop-in superset of `react-hot-toast`'s default export, so a
 * call site can switch its import without any other change.
 */
const toastManager = (message, options) => toastManager.spawn('default', message, options);
Object.assign(toastManager, createToastQueue(reactHotToastEngine));

/** Alias kept for call sites that use the react-hot-toast name. */
toastManager.remove = toastManager.dismiss;
toastManager.isActive = (id) => (reactHotToastEngine.isActive ? reactHotToastEngine.isActive(id) : false);

export default toastManager;