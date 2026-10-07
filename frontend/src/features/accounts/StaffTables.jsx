import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const time = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }) : '—');
const dayParam = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const clockLabel = (iso, day) => {
  if (!iso) return '—';
  const at = new Date(iso);
  const sameDay = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' }) === day;
  return sameDay ? time(iso) : `${at.toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })}, ${time(iso)}`;
};
const statusWords = (status) => String(status || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/**
 * Staff tab of Accounts: two small tables side by side. Left: every staff account (Edit, Deactivate).
 * Right: who is working today, with clock-in and clock-out times; a name opens that person's bookings for today.
 */
export default function StaffTables({ members, loading, isSubmitting, onEdit, onDeactivate, isProtected }) {
  const [today, setToday] = useState([]);
  const [todayLoading, setTodayLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [date, setDate] = useState(() => new Date());
  const [pickerOpen, setPickerOpen] = useState(false);
  const day = dayParam(date);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc('staff_today', { p_day: day });
    setToday(data?.staff || []);
    setTodayLoading(false);
  }, [day]);

  useEffect(() => {
    setTodayLoading(true);
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const isToday = day === dayParam(new Date());
  const dayLabel = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="ui-root grid gap-4 lg:grid-cols-2">
      <section className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead className="pr-4 text-right"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={2} className="py-6 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!loading && members.length === 0 && <TableRow><TableCell colSpan={2} className="py-6 text-center text-muted-foreground">No staff found.</TableCell></TableRow>}
            {!loading && members.map((member) => {
              const busy = member.hasActiveServices;
              return (
                <TableRow key={member.id}>
                  <TableCell className="pl-4">
                    <div className="font-medium">{member.full_name}</div>
                    <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{member.email}</div>
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="outline" onClick={() => onEdit(member)} aria-label={`Edit ${member.full_name || member.email}`}>Edit</Button>
                      {!isProtected(member) && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive"
                          disabled={isSubmitting || busy}
                          title={busy ? 'Has work assigned. Reassign it first.' : undefined}
                          onClick={() => onDeactivate(member)}
                        >
                          {busy ? 'Has work' : 'Deactivate'}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <section className="rounded-lg border">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <h3 className="text-sm font-semibold">{isToday ? 'Working today' : 'Worked on'}</h3>
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm"><CalendarDays /> {dayLabel}</Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <Calendar mode="single" selected={date} onSelect={(picked) => { if (picked) { setDate(picked); setPickerOpen(false); } }} disabled={{ after: new Date() }} />
            </PopoverContent>
          </Popover>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="pl-4">Name</TableHead>
              <TableHead>In</TableHead>
              <TableHead className="pr-4">Out</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {todayLoading && <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">Loading…</TableCell></TableRow>}
            {!todayLoading && today.length === 0 && <TableRow><TableCell colSpan={3} className="py-6 text-center text-muted-foreground">{isToday ? 'No one has clocked in today.' : 'No one clocked in on this day.'}</TableCell></TableRow>}
            {!todayLoading && today.map((person) => {
              const first = person.sessions?.[0];
              const last = person.sessions?.[person.sessions.length - 1];
              return (
                <TableRow key={person.id}>
                  <TableCell className="pl-4">
                    <button type="button" onClick={() => setSelected(person)} className="text-left font-medium underline-offset-4 hover:underline">
                      {person.name}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{clockLabel(first?.clock_in_at, day)}</TableCell>
                  <TableCell className="whitespace-nowrap pr-4">
                    {person.on_duty ? <span className="text-green-600">On duty</span> : clockLabel(last?.clock_out_at, day)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="ui-root max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{selected?.name}</DialogTitle>
            <DialogDescription>Bookings on {dayLabel}</DialogDescription>
          </DialogHeader>
          {selected && (selected.vehicles || []).length === 0 && <p className="text-sm text-muted-foreground">No bookings assigned on this day.</p>}
          <ul className="m-0 grid list-none gap-2 p-0">
            {(selected?.vehicles || []).map((v) => (
              <li key={v.id} className="rounded-md border px-3 py-2 text-sm">
                <div className="flex justify-between gap-3">
                  <strong>{time(v.start_datetime)} · {[v.brand, v.model].filter(Boolean).join(' ') || 'Vehicle'}</strong>
                  <span className="text-xs text-muted-foreground">{statusWords(v.status)}</span>
                </div>
                <div className="text-muted-foreground">{[v.plate_number, v.customer_name].filter(Boolean).join(' · ')}</div>
                {(v.services || []).length > 0 && <div className="mt-1">{v.services.join(', ')}</div>}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
