import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle, Search } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import BookingChat from '@/components/BookingChat';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })
    : date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
};

/**
 * Admin Chat page (master plan 4.7). The same conversations the floating bubble lists
 * (admin_chat_threads through ChatContext): one continuous thread per customer, each message
 * optionally tagged with a booking like a ticket reference. The bubble is only a shortcut to
 * this; both read the same thread list and unread counters.
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

  return (
    <div className="ui-root flex flex-col gap-4 pb-6">
      <PageHeader
        badge="MESSAGES"
        title="Chat"
        subtitle="Every customer conversation in one place. Tag a message with a booking so the context stays with it."
      />

      <div className="grid overflow-hidden rounded-lg border bg-card" style={{ gridTemplateColumns: isMobile ? '1fr' : '340px 1fr', height: 'calc(100vh - 15rem)', minHeight: '520px' }}>
        {showList && (
          <aside className="flex min-h-0 flex-col border-r" aria-label="Conversations">
            <div className="flex flex-col gap-2 border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search customer, message or booking"
                  aria-label="Search conversations"
                  data-no-auto-capitalize="true"
                  className="h-9 w-full rounded-md border bg-transparent pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant={unreadOnly ? 'outline' : 'default'} onClick={() => setUnreadOnly(false)}>All</Button>
                <Button size="sm" variant={unreadOnly ? 'default' : 'outline'} onClick={() => setUnreadOnly(true)}>
                  Unread{totalUnread > 0 ? ` (${totalUnread})` : ''}
                </Button>
              </div>
            </div>

            <ul className="min-h-0 flex-1 overflow-y-auto">
              {threadsLoading && threads.length === 0 && <li className="p-4 text-sm text-muted-foreground">Loading conversations…</li>}
              {!threadsLoading && visible.length === 0 && (
                <li className="p-4 text-sm text-muted-foreground">
                  {threads.length === 0 ? 'No conversations yet. They appear when a customer writes to the shop.' : 'No conversation matches.'}
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
                      className={`flex w-full flex-col gap-1 border-b px-3 py-3 text-left transition-colors hover:bg-muted/60 ${active ? 'bg-muted' : ''}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate text-sm ${unread ? 'font-bold' : 'font-semibold'}`}>{thread.customer_name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">{timeLabel(thread.last_message_at)}</span>
                      </span>
                      <span className="flex items-center justify-between gap-2">
                        <span className={`truncate text-xs ${unread ? 'text-foreground' : 'text-muted-foreground'}`}>{previewOf(thread)}</span>
                        {unread > 0 && <Badge className="shrink-0">{unread}</Badge>}
                      </span>
                      {tags.length > 0 && (
                        <span className="flex flex-wrap gap-1">
                          {tags.slice(0, 2).map((id) => <Badge key={id} variant="outline" className="font-mono text-[10px]">{shortRef(id)}</Badge>)}
                          {tags.length > 2 && <Badge variant="outline" className="text-[10px]">+{tags.length - 2}</Badge>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        )}

        {showConversation && (
          <section className="flex min-h-0 min-w-0 flex-col" aria-label="Conversation">
            {selected ? (
              <>
                <header className="flex items-center gap-3 border-b px-4 py-3">
                  {isMobile && (
                    <Button size="icon" variant="ghost" aria-label="Back to conversations" onClick={() => select(null)}><ArrowLeft /></Button>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{selected.customer_name}</p>
                    {selected.customer_email && <p className="truncate text-xs text-muted-foreground">{selected.customer_email}</p>}
                  </div>
                </header>
                <div className="min-h-0 flex-1 overflow-hidden">
                  <BookingChat key={selected.customer_id} customerId={selected.customer_id} bookingId={bookingTag} />
                </div>
              </>
            ) : (
              <div className="m-auto flex flex-col items-center gap-2 p-8 text-center text-muted-foreground">
                <MessageCircle className="size-8" />
                <p className="text-sm">Select a conversation to read and reply.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
