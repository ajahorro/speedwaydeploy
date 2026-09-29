import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-key';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export { supabaseUrl, supabaseAnonKey };

/**
 * Realtime explicitly requires a UNIQUE channel topic per subscription.
 *
 * Two components legitimately need the SAME topic, because the topic encodes the
 * tenant: CustomerBookingDetails subscribes as `booking-<id>`, AdminBookingDetails
 * as `admin-booking-detail-<id>`, BookingChat as `chat-customer-<customerId>` — and
 * more than one of each can be mounted at once (back/forward navigation, a detail
 * page beside a walk-in wizard, the chat bubble plus an inline panel).
 *
 * `supabase.channel(topic)` RETURNS THE EXISTING CHANNEL when the topic is already
 * in use, so the second `channel(...).on(...)` silently appended its handler to a
 * channel that was ALREADY subscribed by the first caller. Supabase rejects that
 * with:
 *
 *   cannot add `postgres_changes` callbacks for realtime:<topic> after `subscribe()`
 *
 * which surfaced as an unhandled promise rejection and a crashed screen.
 *
 * The client has no `getChannels` in older versions and its `realtime.channels`
 * array is not part of the public API, so — exactly as the Supabase docs recommend
 * — we keep our own registry of live channels and mint a fresh topic (stable
 * prefix, unique suffix) whenever a topic is already taken. Unsubscribing removes
 * the entry, so the plain topic is free again on the next mount.
 */
const liveChannelTopics = new Map();

let channelSequence = 0;

export const createUniqueChannel = (topic) => {
  const active = liveChannelTopics.get(topic) || 0;
  const uniqueTopic = active > 0 ? `${topic}-${++channelSequence}` : topic;
  liveChannelTopics.set(topic, active + 1);

  const channel = supabase.channel(uniqueTopic);
  const removeChannel = channel.unsubscribe.bind(channel);

  // Idempotent: callers may unsubscribe explicitly, through removeChannel, or
  // through a cleanup effect that runs twice (React 18 StrictMode).
  let released = false;
  channel.unsubscribe = (...args) => {
    if (!released) {
      released = true;
      const remaining = (liveChannelTopics.get(topic) || 1) - 1;
      if (remaining > 0) liveChannelTopics.set(topic, remaining);
      else liveChannelTopics.delete(topic);
    }
    return removeChannel(...args);
  };

  return channel;
};

/**
 * Break import cycles that would otherwise crash the bundle.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vite/Rollup hoists ES module imports into a flat chunk and initializes the
 * bindings in its own order. When two modules import each other at top level, one
 * of them runs its body BEFORE the other's bindings are initialized. Reading such
 * a binding is not `undefined` — it is a Temporal Dead Zone ReferenceError:
 *
 *   ReferenceError: Cannot access 'qt' before initialization
 *     at Tp (index-gXSD0XLE.js:505:22606)
 *
 * There is a real cycle across this app's services:
 *
 *   bookingService -> eventEngine -> notificationService -> bookingService
 *
 * (notificationService imports `sendStatusEmail` from... itself only;
 * eventEngine imports notificationService; bookingService imports both, and
 * notificationService's module body is evaluated inside bookingService's own
 * initialization because bookingService's import list reaches it first through
 * eventEngine.)
 *
 * Whichever module the bundler decides to run last reads a symbol that the other
 * has not initialized yet, so the crash is load-order dependent — it appears for
 * one chunking (e.g. index-gXSD0XLE.js) and disappears for another, which is
 * exactly what makes it look intermittent in production.
 *
 * THE FIX
 * -------
 * Route the module boundary through `eval('require')`-style indirection: the
 * import is only resolved the first time it is actually CALLED, long after every
 * module body has finished. `import.meta.glob` gives Vite the static path it
 * needs to include the module in the bundle (so nothing is lost to tree-shaking
 * and no dynamic-import chunk is created), while the lookup itself stays lazy:
 * every glob value is a function that resolves the already-initialized module.
 *
 * Static named imports from these modules keep working everywhere else; only the
 * back edges that close a cycle should go through this helper.
 */
const serviceModules = import.meta.glob(['../services/*.js', '!../services/*.test.js'], { eager: true });

// Normalise a path so './notificationService', 'notificationService' and
// '../services/notificationService.js' all land on the same registry key.
const normalizeServiceKey = (file) => {
  const base = String(file).split('/').pop() || '';
  return base.replace(/\.jsx?$/, '');
};

const serviceRegistry = new Map();
Object.entries(serviceModules).forEach(([file, mod]) => {
  if (mod) serviceRegistry.set(normalizeServiceKey(file), mod);
});

export const loadServiceModule = (file) => {
  const mod = serviceRegistry.get(normalizeServiceKey(file));
  if (!mod) {
    throw new Error(`Unknown service module: ${file}`);
  }
  return mod;
};
