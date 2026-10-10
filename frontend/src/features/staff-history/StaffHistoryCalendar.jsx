import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock, Car, CalendarDays } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useLanguage } from '@/context/LanguageContext';
import { Badge } from '@/components/ui/badge';
import { Calendar } from '@/components/ui/calendar';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const pad = (n) => String(n).padStart(2, '0');
const toKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromKey = (key) => new Date(`${key}T00:00:00`);
const statusWords = (status) => String(status || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

const hoursBetween = (from, to) => {
  const minutes = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000));
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`;
};

const STATUS_TONE = {
  COMPLETED: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  IN_PROGRESS: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  CANCELLED: 'border-destructive/40 bg-destructive/10 text-destructive'
};

/**
 * The technician's own history as a calendar. Wide screens: the services of the chosen day on the left (scrolls), the
 * month calendar on the right (stays in view). Phones: the calendar first, the day below it. Days with a shift or a
 * vehicle carry a dot. Dates and times follow the chosen language; colours follow the theme.
 */
export default function StaffHistoryCalendar({ staffId }) {
  const { language } = useLanguage();
  const locale = language === 'tl' ? 'fil-PH' : 'en-US';
  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState(() => new Date());
  const [days, setDays] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fmtTime = useCallback((iso) => (iso ? new Date(iso).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) : '—'), [locale]);
  const fmtDay = useCallback((date) => date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), [locale]);

  const load = useCallback(async (visibleMonth) => {
    if (!staffId) return;
    setLoading(true);
    setError('');
    const first = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
    const last = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0);
    try {
      const { data, error: rpcError } = await supabase.rpc('staff_work_history_range', { p_staff: staffId, p_from: toKey(first), p_to: toKey(last) });
      if (rpcError) throw rpcError;
      setDays(new Map((data?.days || []).map((entry) => [entry.day, entry])));
    } catch (err) {
      setError(err.message || 'Could not load the history.');
    } finally {
      setLoading(false);
    }
  }, [staffId]);

  useEffect(() => { load(month); }, [month, load]);

  const worked = useMemo(() => [...days.keys()].map(fromKey), [days]);
  const entry = days.get(toKey(selected));
  const sessions = entry?.sessions || [];
  const vehicles = entry?.vehicles || [];

  return (
    <div className="ui-root grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
      {/* The day */}
      <Card className="order-2 gap-0 overflow-hidden p-0 lg:order-1 lg:max-h-[calc(100vh-11rem)] lg:overflow-y-auto">
        <div className="border-b bg-muted/40 px-4 py-3">
          <h2 className="text-sm font-bold">{fmtDay(selected)}</h2>
          <div className="mt-2 grid gap-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Clock className="size-3.5" aria-hidden="true" /> Clock in and out</p>
            {loading ? <Skeleton className="h-5 w-48" /> : sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No clock-in on this day.</p>
            ) : (
              <ul className="m-0 grid list-none gap-1 p-0 text-sm">
                {sessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap justify-between gap-x-4">
                    <span>{fmtTime(s.clock_in_at)} → {s.clock_out_at ? fmtTime(s.clock_out_at) : <em>still on shift</em>}</span>
                    <span className="text-muted-foreground">{s.clock_out_at ? hoursBetween(s.clock_in_at, s.clock_out_at) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid gap-3 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground"><Car className="size-3.5" aria-hidden="true" /> Services</p>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : loading ? (
            <><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></>
          ) : vehicles.length === 0 ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">No vehicles scheduled on this day.</p>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0">
              {vehicles.map((v) => (
                <li key={v.id} className="grid gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold [overflow-wrap:anywhere]">{[v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle'} · {v.plate_number || 'No plate'}</p>
                      <p className="text-xs text-muted-foreground">{v.vehicle_type || '—'}</p>
                    </div>
                    <Badge variant="outline" className={`whitespace-nowrap uppercase ${STATUS_TONE[String(v.status || '').toUpperCase()] || ''}`}>{statusWords(v.status)}</Badge>
                  </div>
                  <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
                    <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Scheduled</dt><dd>{fmtTime(v.start_datetime)}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Started</dt><dd>{fmtTime(v.started_at)}</dd></div>
                    <div><dt className="text-xs font-semibold uppercase text-muted-foreground">Finished</dt><dd>{fmtTime(v.completed_at)}</dd></div>
                  </dl>
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Services</p>
                    {(v.services || []).length ? (
                      <ul className="m-0 mt-1 list-disc pl-5 text-sm">{v.services.map((name, index) => <li key={`${name}-${index}`} className="[overflow-wrap:anywhere]">{name}</li>)}</ul>
                    ) : <p className="text-sm text-muted-foreground">—</p>}
                  </div>
                  {v.service_notes && <p className="rounded-md bg-muted/50 px-2 py-1.5 text-sm [overflow-wrap:anywhere]">{v.service_notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* The month */}
      <Card className="order-1 items-center gap-0 p-2 lg:sticky lg:top-24 lg:order-2">
        <Calendar
          mode="single"
          required
          selected={selected}
          onSelect={(date) => date && setSelected(date)}
          month={month}
          onMonthChange={setMonth}
          modifiers={{ worked }}
          modifiersClassNames={{ worked: 'font-bold underline decoration-primary decoration-2 underline-offset-4' }}
          formatters={{
            formatCaption: (date) => date.toLocaleDateString(locale, { month: 'long', year: 'numeric' }),
            formatWeekdayName: (date) => date.toLocaleDateString(locale, { weekday: 'short' })
          }}
          className="w-full [--cell-size:--spacing(10)] sm:[--cell-size:--spacing(9)]"
        />
        <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-muted-foreground"><CalendarDays className="size-3.5" aria-hidden="true" /> Underlined days have a shift or a vehicle.</p>
      </Card>
    </div>
  );
}
