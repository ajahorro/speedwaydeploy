const MINUTES_PER_DAY = 24 * 60;
const SHOP_OFFSET_MINUTES = 8 * 60;

const parseTime = (value) => {
  if (value == null || value === '') return null;
  const match = String(value).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error('Closure times must use HH:MM or HH:MM:SS.');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (minutes > 59 || seconds > 59 || hours > 24 || (hours === 24 && (minutes !== 0 || seconds !== 0))) {
    throw new Error('Closure times must be between 00:00 and 24:00.');
  }
  return hours * 60 + minutes + (seconds > 0 ? seconds / 60 : 0);
};

const timeRangeOf = (block) => {
  const start = parseTime(block.start_time);
  const end = parseTime(block.end_time);
  if (start == null && end == null) return { start: 0, end: MINUTES_PER_DAY };
  if (start == null || end == null || start >= end) {
    throw new Error('Choose a valid start and end time, or leave both times empty to close the full day.');
  }
  return { start, end };
};

const blockedSlotsOverlap = (candidate, existing) => {
  if (String(candidate.block_date).slice(0, 10) !== String(existing.block_date).slice(0, 10)) return false;
  const a = timeRangeOf(candidate);
  const b = timeRangeOf(existing);
  return a.start < b.end && b.start < a.end;
};

const parseDate = (date) => {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Closure date must use YYYY-MM-DD.');
  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error('Choose a valid closure date.');
  }
  return parsed;
};

const shopDateTimeIso = (date, minutes) => {
  const day = parseDate(date);
  return new Date(day.getTime() + (minutes - SHOP_OFFSET_MINUTES) * 60 * 1000).toISOString();
};

const blockWindow = (block) => {
  const range = timeRangeOf(block);
  return {
    start: shopDateTimeIso(block.block_date, range.start),
    end: shopDateTimeIso(block.block_date, range.end),
  };
};

module.exports = { blockedSlotsOverlap, blockWindow, timeRangeOf };
