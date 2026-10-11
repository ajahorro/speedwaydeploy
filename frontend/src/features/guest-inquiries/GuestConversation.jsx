import { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import toast from '@/lib/toast';
import { supabase } from '@/lib/supabase';
import { subscribeTable } from '@/lib/realtimeHub';
import { BACKEND_URL, authHeaders } from '@/config/api';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const timeLabel = (iso) => new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });

/**
 * One website visitor's conversation (no account). Their messages arrive from the landing page form; every reply
 * written here is e-mailed to the address they gave, and the e-mail invites them to create an account.
 */
export default function GuestConversation({ inquiryId, email, onChanged }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('guest_inquiry_messages').select('id, sender, body, emailed_at, email_error, created_at').eq('inquiry_id', inquiryId).order('created_at');
    if (error) { toast.error('Could not load this conversation.'); return; }
    setMessages(data || []);
    setLoading(false);
    if ((data || []).some((m) => m.sender === 'guest')) {
      supabase.rpc('mark_guest_inquiry_read', { p_inquiry: inquiryId }).then(() => onChanged?.());
    }
  }, [inquiryId, onChanged]);

  useEffect(() => {
    setLoading(true);
    load();
    return subscribeTable({ table: 'guest_inquiry_messages', filter: `inquiry_id=eq.${inquiryId}` }, load);
  }, [inquiryId, load]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const response = await fetch(`${BACKEND_URL}/api/admin/inquiries/reply`, { method: 'POST', headers: await authHeaders(), body: JSON.stringify({ inquiryId, body }) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'The reply could not be sent.');
      setText('');
      if (result.emailed) toast.success(`Reply emailed to ${email}.`);
      else toast.error(`Saved, but the email to ${email} was not sent${result.emailError ? `: ${result.emailError}` : ''}.`);
      await load();
      onChanged?.();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {messages.map((m) => {
              const mine = m.sender === 'admin';
              return (
                <li key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
                  <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm [overflow-wrap:anywhere] ${mine ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>{m.body}</div>
                  <span className="mt-1 text-[11px] text-muted-foreground">
                    {timeLabel(m.created_at)}
                    {mine && (m.emailed_at ? ' · Emailed' : ` · Not emailed${m.email_error ? `: ${m.email_error}` : ''}`)}
                  </span>
                </li>
              );
            })}
            <li ref={endRef} />
          </ul>
        )}
      </div>
      <div className="grid gap-2 border-t p-3">
        <p className="text-xs text-muted-foreground">This visitor has no account. Your reply is emailed to {email}.</p>
        <div className="flex items-end gap-2">
          <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={2} maxLength={4000} placeholder="Write a reply…" className="min-h-0 flex-1 resize-none"
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) send(); }} />
          <Button type="button" onClick={send} disabled={sending || !text.trim()}><Send /> {sending ? 'Sending…' : 'Send'}</Button>
        </div>
      </div>
    </div>
  );
}
