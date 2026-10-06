import { useState } from 'react';
import { CalendarRange } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RANGE_PRESETS } from './useReportRange';

export const formatRangeLabel = ({ from, to }) => {
  const last = new Date(to.getTime() - 1);
  const options = { month: 'short', day: 'numeric', year: 'numeric' };
  return from.toDateString() === last.toDateString()
    ? from.toLocaleDateString('en-PH', options)
    : `${from.toLocaleDateString('en-PH', options)} – ${last.toLocaleDateString('en-PH', options)}`;
};

export function RangeFilter({ preset, range, onPresetChange, onCustomRange }) {
  const [draft, setDraft] = useState({ from: range.from, to: new Date(range.to.getTime() - 1) });
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select value={preset} onValueChange={onPresetChange}>
        <SelectTrigger className="w-full sm:w-[170px]" aria-label="Report period">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RANGE_PRESETS.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="justify-start font-normal">
            <CalendarRange /> {formatRangeLabel(range)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={draft}
            onSelect={(value) => setDraft(value || { from: undefined, to: undefined })}
            disabled={{ after: new Date() }}
          />
          <div className="flex justify-end gap-2 border-t p-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!draft?.from}
              onClick={() => { onCustomRange(draft.from, draft.to || draft.from); setOpen(false); }}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
