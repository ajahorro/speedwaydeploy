import React from 'react';
import {
  CalendarX2, CalendarOff, Ban, CalendarClock, Timer, Clock3, Users, AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * <ValidationModal>
 * ============================================================================
 * Batch 6 / Step 6.3 — Guided schedule-restriction feedback.
 *
 * A reusable modal that turns a structured schedule-validation failure (from
 * POST /api/bookings/validate-slot) into a clear, friendly, actionable message.
 *
 * It is deliberately presentational + dumb: the parent decides what the actions
 * do. Two actions are supported and both are optional:
 *   - onPickAnotherTime()      "Pick Another Time"          (primary)
 *   - onSelectNextAvailable()  "Select Next Available Date" (secondary)
 *
 * Error codes it understands (mirrors the backend vocabulary):
 *   PAST_DATE, CLOSED_WEEKDAY, BLOCKED_DATE, BEYOND_ADVANCE_WINDOW,
 *   LEAD_TIME, SLOT_UNAVAILABLE, CAPACITY_EXCEEDED
 * Unknown codes fall back to a generic-but-safe presentation, so a future
 * backend code can never render an empty modal.
 *
 * Styling: native project CSS tokens only (var(--admin-*)), full dark/light
 * support, and a 375px-safe single-column layout.
 */

// Per-code presentation: icon, tinted accent, title, and next-step guidance.
const CODE_PRESENTATION = {
  PAST_DATE: {
    icon: CalendarX2,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Invalid date',
    title: 'That date has passed',
    guidance: 'Please choose today or a future date to continue.',
  },
  CLOSED_WEEKDAY: {
    icon: CalendarOff,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Shop closed',
    title: 'We are closed on that day',
    guidance: 'Select another day of the week when the shop is open.',
  },
  BLOCKED_DATE: {
    icon: Ban,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Date unavailable',
    title: 'This date is blocked',
    guidance: 'The shop has marked this date as unavailable. Please pick a different day.',
  },
  BEYOND_ADVANCE_WINDOW: {
    icon: CalendarClock,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Too far ahead',
    title: 'That date is too far in advance',
    guidance: 'Bookings open closer to the day. Choose an earlier date within our booking window.',
  },
  LEAD_TIME: {
    icon: Timer,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Notice too short',
    title: 'This slot is too soon',
    guidance: 'We need more notice to prepare. Please pick a later time today or another day.',
  },
  SLOT_UNAVAILABLE: {
    icon: Clock3,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Slot unavailable',
    title: 'That time is not available',
    guidance: 'The shop has reserved or blocked this slot. Please choose another time.',
  },
  CAPACITY_EXCEEDED: {
    icon: Users,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Fully booked',
    title: 'That slot is fully booked',
    guidance: 'All bays are taken for this time. Try a different time or another day.',
  },
  // Fallbacks for malformed requests / infra hiccups.
  INVALID_DATE: {
    icon: CalendarX2,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Check the date',
    title: 'We could not read that date',
    guidance: 'Please reselect a valid date and try again.',
  },
  INVALID_SLOT: {
    icon: Clock3,
    accent: 'var(--status-danger)',
    accentRgb: '239, 68, 68',
    eyebrow: 'Check the time',
    title: 'We could not read that time',
    guidance: 'Please reselect a valid start time and try again.',
  },
  // Backend unreachable (fail-closed). This is a transient, retryable state.
  VALIDATION_UNAVAILABLE: {
    icon: AlertTriangle,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Connection issue',
    title: 'We could not confirm this slot',
    guidance: 'Our scheduling service is temporarily unavailable. Please try submitting again in a moment.',
  },
  DEFAULT: {
    icon: AlertTriangle,
    accent: 'var(--status-warning)',
    accentRgb: '245, 158, 11',
    eyebrow: 'Not available',
    title: 'That slot is not available',
    guidance: 'Please pick another time or date to continue.',
  },
};

const ValidationModal = ({
  open,
  code,
  message,
  details,
  onClose,
  onPickAnotherTime,
  onSelectNextAvailable,
}) => {
  if (!open) return null;

  const presentation = CODE_PRESENTATION[code] || CODE_PRESENTATION.DEFAULT;
  const Icon = presentation.icon;
  // The server message is the specific, contextual explanation; the per-code
  // `guidance` is the generic actionable next step. They are distinct, so we
  // only show the body paragraph when the server actually sent a message —
  // otherwise the guidance line alone carries the explanation (no duplication).
  const serverMessage = typeof message === 'string' && message.trim() ? message.trim() : null;

  // Human-readable echo of what the user attempted (date/time), when known.
  const attempted = [
    details?.date,
    details?.time,
  ].filter(Boolean).join(' · ');

  // Only render an action when its handler exists — keeps the modal honest.
  const showPickTime = typeof onPickAnotherTime === 'function';
  const showNextDate = typeof onSelectNextAvailable === 'function';
  const dismissible = typeof onClose === 'function';

  return (
    <Dialog open onOpenChange={(next) => { if (!next && dismissible) onClose(); }}>
      <DialogContent
        className="ui-root sm:max-w-md"
        showCloseButton={dismissible}
        onInteractOutside={(event) => { if (!dismissible) event.preventDefault(); }}
        onEscapeKeyDown={(event) => { if (!dismissible) event.preventDefault(); }}
      >
        <DialogHeader>
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: presentation.accent }}>{presentation.eyebrow}</p>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="size-5 shrink-0" style={{ color: presentation.accent }} aria-hidden="true" />
            {presentation.title}
          </DialogTitle>
          <DialogDescription>{presentation.guidance}</DialogDescription>
        </DialogHeader>

        {/* Server explanation — only when it adds something beyond the guidance. */}
        {serverMessage && serverMessage !== presentation.guidance && (
          <p className="text-sm text-muted-foreground">{serverMessage}</p>
        )}

        {attempted && (
          <p className="rounded-md border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Requested: <span className="text-foreground">{attempted}</span>
          </p>
        )}

        {(showNextDate || showPickTime) && (
          <DialogFooter>
            {showNextDate && <Button type="button" variant="outline" onClick={onSelectNextAvailable}>Select Next Available Date</Button>}
            {showPickTime && <Button type="button" onClick={onPickAnotherTime}>Pick Another Time</Button>}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ValidationModal;
