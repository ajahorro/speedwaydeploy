// An email link always opens a new tab, and a page cannot send that click to the tab the person was already using.
// So the new tab finishes the job, tells the other Comar Garage tabs (they move on by themselves), then steps aside.
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('comar-tabs');

// every open tab answers "here" so a new tab can tell whether an older one exists
channel?.addEventListener('message', (e) => { if (e.data?.kind === 'ping') channel.postMessage({ kind: 'here' }); });

/** Tell the other tabs a job is done; resolves true when another tab is open (this one then tries to close). */
export const handOff = (kind) => new Promise((resolve) => {
  if (!channel) return resolve(false);
  let found = false;
  const onReply = (e) => { if (e.data?.kind === 'here') found = true; };
  channel.addEventListener('message', onReply);
  channel.postMessage({ kind: 'ping' });
  setTimeout(() => {
    channel.removeEventListener('message', onReply);
    if (found) { channel.postMessage({ kind }); window.close(); }
    resolve(found);
  }, 400);
});

/** Run fn(kind) when another tab finishes a job; returns the unsubscribe function. */
export const onHandOff = (fn) => {
  if (!channel) return () => {};
  const listener = (e) => { if (e.data?.kind && !['ping', 'here'].includes(e.data.kind)) fn(e.data.kind); };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
};
