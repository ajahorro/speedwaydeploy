import { supabase, createUniqueChannel } from './supabase';

/**
 * One realtime channel per (table, filter, event), shared by every screen.
 *
 * Before this, each screen opened its own channel, so the same table (for
 * example `notifications` for the signed-in user, or all `bookings`) was
 * subscribed three or four times by components mounted together. Each extra
 * channel is another server-side subscription and another event to handle.
 *
 * Usage:
 *   const stop = subscribeTable({ table: 'bookings', filter: `id=eq.${id}` }, refetch);
 *   // later: stop();
 *
 * - `callback(payload)` receives the postgres_changes payload, or `{ resync: true }`
 *   when events may have been missed (the tab was hidden for a while, or the page
 *   was restored from the back/forward cache). Listeners should simply refetch.
 * - A channel with no listeners is closed after a short grace period, so a route
 *   change (unmount then mount) reuses the open channel instead of reconnecting.
 */

const entries = new Map(); // key -> { channel, listeners:Set<fn>, closeTimer }
const CLOSE_GRACE_MS = 3000;
const RESYNC_AFTER_HIDDEN_MS = 30000;

const keyOf = ({ table, filter = '', event = '*' }) => `${table}|${filter}|${event}`;

const open = (spec) => {
  const key = keyOf(spec);
  let entry = entries.get(key);
  if (entry) {
    if (entry.closeTimer) {
      clearTimeout(entry.closeTimer);
      entry.closeTimer = null;
    }
    return entry;
  }

  entry = { channel: null, listeners: new Set(), closeTimer: null };
  const config = { event: spec.event || '*', schema: 'public', table: spec.table };
  if (spec.filter) config.filter = spec.filter;

  entry.channel = createUniqueChannel(`hub:${key}`)
    .on('postgres_changes', config, (payload) => {
      entry.listeners.forEach((fn) => {
        try { fn(payload); } catch (error) { console.error('[realtimeHub] listener failed:', error); }
      });
    })
    .subscribe();

  entries.set(key, entry);
  return entry;
};

const release = (spec, fn) => {
  const key = keyOf(spec);
  const entry = entries.get(key);
  if (!entry) return;
  entry.listeners.delete(fn);
  if (entry.listeners.size > 0 || entry.closeTimer) return;
  entry.closeTimer = setTimeout(() => {
    if (entry.listeners.size === 0) {
      supabase.removeChannel(entry.channel);
      entries.delete(key);
    }
  }, CLOSE_GRACE_MS);
};

export const subscribeTable = (spec, callback) => {
  const entry = open(spec);
  entry.listeners.add(callback);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    release(spec, callback);
  };
};

/** Subscribe one callback to several tables; returns a single stop function. */
export const subscribeTables = (specs, callback) => {
  const stops = specs.map((spec) => subscribeTable(spec, callback));
  return () => stops.forEach((stop) => stop());
};

// Events can be missed while the tab is hidden or frozen in the bfcache
// ("Page entered Back-Forward Cache" closes the socket). Tell every listener to
// refetch once the page is visible again.
const resyncAll = () => {
  entries.forEach((entry) => {
    entry.listeners.forEach((fn) => {
      try { fn({ resync: true }); } catch (error) { console.error('[realtimeHub] resync failed:', error); }
    });
  });
};

if (typeof window !== 'undefined' && !window.__realtimeHubResyncInstalled) {
  window.__realtimeHubResyncInstalled = true;
  let hiddenAt = 0;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > RESYNC_AFTER_HIDDEN_MS) {
      try { supabase.realtime.connect(); } catch { /* the client reconnects on its own */ }
      resyncAll();
    }
    hiddenAt = 0;
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      try { supabase.realtime.connect(); } catch { /* the client reconnects on its own */ }
      resyncAll();
    }
  });
}
