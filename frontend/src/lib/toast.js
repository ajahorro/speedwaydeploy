import { toast as sonner } from 'sonner';

/**
 * The app's toast API. It keeps the call style the code already uses (`toast.success(...)`,
 * `toast.error(...)`, `toast.loading(...)`, `toast.dismiss(id)`, `toast.custom(...)`) and shows
 * every toast with shadcn's Sonner, hosted once in main.jsx (components/ui/sonner.jsx).
 *
 * Options understood: `id`, `duration`, `position`, `icon`, `className`. Anything else
 * (including inline styles) is ignored on purpose: the look comes from the one toast host.
 * A message may be text, JSX, or a function `(t) => JSX` (t.id is the toast id).
 */
const mapOptions = (options) => {
  if (!options || typeof options !== 'object') return {};
  const out = {};
  if (options.id !== undefined) out.id = options.id;
  if (options.duration !== undefined) out.duration = options.duration;
  if (options.position) out.position = options.position;
  if (options.icon) out.icon = options.icon;
  if (options.className) out.className = options.className;
  return out;
};

const render = (fn) => (id) => fn({ id, visible: true });

const normalizeMessage = (message) => {
  if (message === undefined || message === null) return null;
  if (typeof message === 'function') return message;
  if (typeof message === 'object') {
    if (message.message && typeof message.message === 'string') return message.message;
    // React elements or custom renderable objects
    return message;
  }
  const str = String(message).trim();
  if (!str || str === 'undefined' || str === 'null') return null;
  return message;
};

// The same text shown again while it is still on screen updates that toast instead of adding a copy.
const wrap = (show, kind) => (message, options) => {
  const cleanMsg = normalizeMessage(message);
  if (!cleanMsg) return null;
  const opts = mapOptions(options);
  if (opts.id === undefined && typeof cleanMsg === 'string' && kind !== 'loading') opts.id = `${kind}:${cleanMsg}`;
  return typeof cleanMsg === 'function'
    ? sonner.custom(render(cleanMsg), opts)
    : show(cleanMsg, opts);
};

const toast = wrap(sonner, 'default');
toast.success = wrap(sonner.success, 'success');
toast.error = wrap(sonner.error, 'error');
toast.warning = wrap(sonner.warning, 'warning');
toast.info = wrap(sonner.info, 'info');
toast.loading = wrap(sonner.loading, 'loading');
toast.custom = (content, options) => {
  const cleanContent = normalizeMessage(content);
  if (!cleanContent) return null;
  return sonner.custom(typeof cleanContent === 'function' ? render(cleanContent) : () => cleanContent, mapOptions(options));
};
toast.promise = (promise, messages = {}, options) => sonner.promise(promise, { loading: messages.loading, success: messages.success, error: messages.error, ...mapOptions(options) });
toast.dismiss = (id) => (id === undefined ? sonner.dismiss() : sonner.dismiss(id));
toast.remove = toast.dismiss;

/**
 * Follow-up notes from the server after an action that SUCCEEDED (an email that could not be sent, a staff
 * alert that could not be refreshed). They are not errors, so they show as one gentle warning, never a pile
 * of red toasts, and the same notes are not shown twice in a row.
 */
toast.followUp = (warnings) => {
  const list = [...new Set((warnings || []).map((w) => String(w || '').trim()).filter(Boolean))];
  if (!list.length) return null;
  return sonner.warning(list.length === 1 ? list[0] : `Done, with ${list.length} follow-up notes`, {
    id: `follow-up:${list.join('|')}`,
    description: list.length > 1 ? list.join(' ') : undefined,
    duration: 6000,
  });
};

export { toast };
export default toast;
