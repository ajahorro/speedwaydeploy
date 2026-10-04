import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export const RANGE_PRESETS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 3 months' },
  { value: 'month', label: 'This month' },
  { value: 'year', label: 'This year' },
  { value: 'custom', label: 'Custom range' }
];

const startOfDay = (date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const parseDate = (value) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const toDateParam = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/** Resolve a preset (or custom dates) into a half-open [from, to) window. */
export const resolveRange = (preset, fromParam, toParam, now = new Date()) => {
  const tomorrow = addDays(startOfDay(now), 1);
  switch (preset) {
    case 'today':
      return { from: startOfDay(now), to: tomorrow };
    case '30d':
      return { from: addDays(tomorrow, -30), to: tomorrow };
    case '90d':
      return { from: addDays(tomorrow, -90), to: tomorrow };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow };
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1), to: tomorrow };
    case 'custom': {
      const from = parseDate(fromParam);
      const to = parseDate(toParam);
      if (from && to && from <= to) return { from: startOfDay(from), to: addDays(startOfDay(to), 1) };
      return { from: addDays(tomorrow, -30), to: tomorrow };
    }
    case '7d':
    default:
      return { from: addDays(tomorrow, -7), to: tomorrow };
  }
};

/**
 * Report filters live in the URL so a report view can be bookmarked, shared
 * with another admin, or refreshed without losing its range.
 */
export function useReportRange(defaultTab = 'overview') {
  const [params, setParams] = useSearchParams();
  const preset = params.get('range') || '30d';
  const fromParam = params.get('from');
  const toParam = params.get('to');
  const tab = params.get('tab') || defaultTab;
  const method = params.get('method') || 'ALL';

  const range = useMemo(
    () => resolveRange(preset, fromParam, toParam),
    // Recompute when the calendar day changes is unnecessary for a report view.
    [preset, fromParam, toParam]
  );

  const update = useCallback((patch) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      Object.entries(patch).forEach(([key, value]) => {
        if (value === null || value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      });
      return next;
    }, { replace: true });
  }, [setParams]);

  return {
    preset,
    range,
    tab,
    method,
    setPreset: (value) => update({ range: value, ...(value === 'custom' ? {} : { from: null, to: null }) }),
    setCustomRange: (from, to) => update({ range: 'custom', from: toDateParam(from), to: toDateParam(to) }),
    setTab: (value) => update({ tab: value }),
    setMethod: (value) => update({ method: value === 'ALL' ? null : value })
  };
}
