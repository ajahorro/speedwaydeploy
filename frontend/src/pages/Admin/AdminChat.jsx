import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Search } from 'lucide-react';
import BookingChat from '@/components/BookingChat';
import { Badge } from '@/components/ui/badge';
import { useGlobalChat } from '@/context/ChatContext';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { matchesSearchText } from '@/utils/searchMatch';

const shortRef = (id) => `#${String(id).slice(0, 8).toUpperCase()}`;

const previewOf = (thread) => {
  if (thread.last_message_type === 'image') return 'Photo';
  if (thread.last_message_type === 'file') return 'File';
  return String(thread.last_message || '').trim() || 'No messages yet';
};

const timeLabel = (iso) => {
  if (!iso) return '';
  const date = new Date(iso);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })
    : date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
};

const initialOf = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();

function Avatar({ name, size = 40 }) {
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-primary font-bold text-primary-foreground"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initialOf(name)}
    </span>
  );
}

/**
 * Message Inquiries (master plan 4.7). Full-bleed workspace: the same conversations the floating
 * bubble lists (admin_chat_threads through ChatContext), one continuous thread per customer, each
 * message optionally tagged with a booking like a ticket reference. Colours come from the theme
 * tokens, so light and dark follow the user's preference; below 900px it shows one pane at a time.
 */
export default function AdminChat() {
  const { threads, threadsLoading, threadUnread } = useGlobalChat();
  const isMobile = useMediaQuery('(max-width: 900px)');
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const selectedId = searchParams.get('customer');
  const bookingTag = searchParams.get('booking') || undefined;

  const select = (customerId, booking) => {
    const next = new URLSearchParams();
    if (customerId) next.set('customer', customerId);
    if (booking) next.set('booking', booking);
    setSearchParams(next, { replace: true });
  };

  // Desktop opens the newest conversation by default; a phone shows the list first.
  const activeId = selectedId || (isMobile ? null : threads[0]?.customer_id || null);
  const unreadOf = (thread) => Number(threadUnread[thread.customer_id] ?? thread.unread_count ?? 0);

  const visible = useMemo(() => threads.filter((thread) => {
    if (unreadOnly && unreadOf(thread) === 0) return false;
    if (!query.trim()) return true;
    return matchesSearchText(query, thread.customer_name, thread.customer_email, previewOf(thread), (thread.booking_ids || []).map(shortRef));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [threads, query, unreadOnly, threadUnread]);

  const selected = threads.find((thread) => thread.customer_id === activeId) || null;
  const totalUnread = threads.reduce((sum, thread) => sum + unreadOf(thread), 0);
  const showList = !isMobile || !selected;
  const showConversation = !isMobile || Boolean(selected);

  // The layout's <main> pads its content; cancel that so the workspace reaches every edge,
  // and let it fill the whole scrolling area (its height is the area plus the padding it cancels).
  const bleed = isMobile ? '-1.5rem -1rem' : '-2.5rem';
  const filterButton = (active) =>
    `h-8 rounded-full border px-3 text-xs font-semibold transition-colors ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-transparent text-muted-foreground hover:bg-muted'}`;

  return (
    <div
      className="ui-root flex overflow-hidden bg-card text-card-foreground"
      style={{ margin: bleed, height: isMobile ? 'calc(100% + 3rem)' : 'calc(100% + 5rem)', minHeight: 0 }}
    >
      <h1 className="sr-only">Message Inquiries</h1>

      {showList && (
        <aside
          className="flex min-h-0 shrink-0 flex-col border-r"
          style={{ width: isMobile ? '100%' : 'clamp(280px, 28vw, 360px)' }}
          aria-label="Conversations"
        >
          <div className="flex flex-col gap-3 border-b p-3">
            <label className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search customer, message or booking"
                aria-label="Search conversations"
                data-no-auto-capitalize="true"
                className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-sm outline-none"
                style={{ boxShadow: 'none' }}
              />
            </label>
            <div className="flex gap-2">
              <button type="button" className={filterButton(!unreadOnly)} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>All</button>
              <button type="button" className={filterButton(unreadOnly)} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
                Unread{totalUnread > 0 ? ` (${totalUnread})` : ''}
              </button>
            </div>
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto">
            {threadsLoading && threads.length === 0 && <li className="p-4 text-sm text-muted-foreground">Loading conversations…</li>}
            {!threadsLoading && visible.length === 0 && (
              <li className="p-4 text-sm text-muted-foreground">
                {threads.length === 0 ? 'No inquiries yet. They appear when a customer writes to the shop.' : 'No conversation matches.'}
              </li>
            )}
            {visible.map((thread) => {
              const unread = unreadOf(thread);
              const active = thread.customer_id === activeId;
              const tags = thread.booking_ids || [];
              return (
                <li key={thread.customer_id}>
                  <button
                    type="button"
                    onClick={() => select(thread.customer_id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-start gap-3 border-b border-l-[3px] px-3 py-3 text-left transition-colors hover:bg-muted/60 ${active ? 'border-l-primary bg-muted' : 'border-l-transparent'}`}
                  >
                    <Avatar name={thread.customer_name} />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate text-sm ${unread ? 'font-bold' : 'font-semibold'}`}>{thread.customer_name}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">{timeLabel(thread.last_message_at)}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate text-xs ${unread ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{previewOf(thread)}</span>
                        {unread > 0 && <Badge className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5">{unread}</Badge>}
                      </span>
                      {tags.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {tags.slice(0, 2).map((id) => <Badge key={id} variant="outline" className="font-mono text-[10px]">{shortRef(id)}</Badge>)}
                          {tags.length > 2 && <Badge variant="outline" className="text-[10px]">+{tags.length - 2}</Badge>}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}

      {showConversation && (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="Conversation">
          {selected ? (
            <>
              <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
                {isMobile && (
                  <button type="button" aria-label="Back to conversations" onClick={() => select(null)}
                    className="-ml-1 flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-muted">
                    <ArrowLeft className="size-5" />
                  </button>
                )}
                <Avatar name={selected.customer_name} size={36} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold leading-tight">{selected.customer_name}</p>
                  {selected.customer_email && <p className="truncate text-xs text-muted-foreground">{selected.customer_email}</p>}
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-hidden">
                <BookingChat key={selected.customer_id} customerId={selected.customer_id} bookingId={bookingTag} />
              </div>
            </>
          ) : (
            <div className="m-auto flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
              <MessageCircle className="size-8" aria-hidden="true" />
              <p className="text-sm">Select a conversation to read and reply.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
