export const formatLocalISODate = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const formatLocalDateTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const buildLocalDateTime = (dateStr, timeStr) => {
  if (!dateStr) return new Date().toISOString();

  const [year, month, day] = String(dateStr).split('-').map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== month - 1 ||
    calendarDay.getUTCDate() !== day
  ) {
    throw new Error('Invalid booking date');
  }

  let hours = 0;
  let minutes = 0;
  if (timeStr) {
    const [timePart, meridian] = String(timeStr).trim().toUpperCase().split(/\s+/);
    const parts = timePart?.split(':').map(Number) || [];
    hours = parts[0];
    minutes = parts[1] ?? 0;
    if (meridian === 'PM' && hours !== 12) hours += 12;
    if (meridian === 'AM' && hours === 12) hours = 0;
  }

  if (!Number.isInteger(hours) || hours < 0 || hours > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    throw new Error('Invalid booking time');
  }

  const singaporeWallTimeAsUtc = Date.UTC(year, month - 1, day, hours - 8, minutes);
  return new Date(singaporeWallTimeAsUtc).toISOString();
};

export const buildLocalDateWindow = (date) => {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

  return {
    start,
    end,
    startIso: `${formatLocalISODate(start)}T00:00:00`,
    endIso: `${formatLocalISODate(end)}T23:59:59`,
  };
};

export const buildLocalMonthWindow = (date) => {
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
  const nextMonthStart = new Date(date.getFullYear(), date.getMonth() + 1, 1, 0, 0, 0, 0);

  return {
    monthStart,
    nextMonthStart,
    startIso: `${formatLocalISODate(monthStart)}T00:00:00`,
    endIso: `${formatLocalISODate(nextMonthStart)}T00:00:00`,
  };
};
