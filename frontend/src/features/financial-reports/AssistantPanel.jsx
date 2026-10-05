import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { supabase } from '@/lib/supabase';
import { BACKEND_URL } from '@/config/api';

const QUICK_QUESTIONS = [
  'How much did we earn this week?',
  'Compare this week with last week',
  'Who owes us the most right now?',
  'Create a report for last month'
];

/**
 * Admin analytics assistant (master plan 4.6). Loaded on demand (React.lazy in the report page),
 * so nothing here weighs on first paint. It only reads reports through the backend and can ask
 * this page to change its date range or export the CSV; it cannot change any data.
 */
export default function AssistantPanel({ open, onOpenChange, range, onSetRange, onExport }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages, busy]);

  const ask = async (question) => {
    const text = String(question || '').trim();
    if (!text || busy) return;
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const response = await fetch(`${BACKEND_URL}/api/admin/analytics-assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
        body: JSON.stringify({ question: text, history, range })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) throw new Error(result.error || 'The assistant is unavailable right now.');
      setMessages((prev) => [...prev, { role: 'assistant', content: result.answer }]);
      (result.actions || []).forEach((action) => {
        if (action.type === 'set_range') onSetRange(action.from, action.to);
        if (action.type === 'export_csv') onExport();
      });
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'assistant', content: error.message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="ui-root flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Sparkles className="size-4" /> Ask about your finances</SheetTitle>
          <SheetDescription>Answers come from the payment ledger. It can open a report for you, but it cannot change any data.</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-2" aria-live="polite">
          {messages.length === 0 && (
            <div className="flex flex-wrap gap-2">
              {QUICK_QUESTIONS.map((question) => (
                <Button key={question} variant="outline" size="sm" className="h-auto whitespace-normal text-left" onClick={() => ask(question)}>{question}</Button>
              ))}
            </div>
          )}
          {messages.map((message, index) => (
            <div key={index} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[88%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${message.role === 'user' ? 'bg-primary text-primary-foreground' : message.error ? 'border border-destructive/50 text-destructive' : 'bg-muted'}`}>
                {message.content}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-muted-foreground">Reading the ledger…</p>}
          <div ref={endRef} />
        </div>

        <form className="flex gap-2 border-t p-3" onSubmit={(event) => { event.preventDefault(); ask(input); }}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={600}
            placeholder="Ask a question…"
            aria-label="Ask the finance assistant"
            data-no-auto-capitalize="true"
            className="h-9 flex-1 rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send"><Send /></Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
