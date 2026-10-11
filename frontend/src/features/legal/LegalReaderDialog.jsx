import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * One short, fixed-size pop-up for every long legal text (terms, privacy, cancellation and refund). The text scrolls
 * inside it, so the page behind is never covered. With `requireRead` the close button (X, Close, Escape, a click outside)
 * stays locked until the reader has scrolled to the end; without it the pop-up can be closed any time.
 */
export default function LegalReaderDialog({ open, onOpenChange, title, description, requireRead = false, children, footer }) {
  const bodyRef = useRef(null);
  const [atEnd, setAtEnd] = useState(!requireRead);
  const [progress, setProgress] = useState(0);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const room = el.scrollHeight - el.clientHeight;
    setProgress(room <= 0 ? 100 : Math.min(100, Math.round((el.scrollTop / room) * 100)));
    if (room - el.scrollTop <= 4) setAtEnd(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setAtEnd(!requireRead);
    setProgress(0);
    const timer = setTimeout(measure, 150); // a text that already fits needs no scrolling
    return () => clearTimeout(timer);
  }, [open, requireRead, measure, title]);

  const locked = requireRead && !atEnd;
  const guard = (event) => { if (locked) event.preventDefault(); };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && locked) return; onOpenChange(next); }}>
      <DialogContent
        showCloseButton={!locked}
        onInteractOutside={guard}
        onEscapeKeyDown={guard}
        className="ui-root flex h-[min(30rem,80dvh)] max-h-[80dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <DialogHeader className="border-b px-5 py-3 pr-12">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div ref={bodyRef} onScroll={measure} tabIndex={0} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm leading-relaxed outline-none">
          {children}
        </div>
        <div className="grid gap-2 border-t px-5 py-3">
          {requireRead && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${atEnd ? 100 : progress}%` }} />
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-xs font-medium text-muted-foreground">
              {locked ? 'Scroll to the end to continue.' : (requireRead ? 'You have read it all.' : '')}
            </p>
            <div className="flex gap-2">
              {footer}
              <Button type="button" size="sm" disabled={locked} onClick={() => onOpenChange(false)}>Close</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
