export const formatLocalISODate = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const formatLocalDateTime = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export const buildLocalDateTime = (dateStr, timeStr) => {
  if (!dateStr) return formatLocalDateTime(new Date());
  if (!timeStr) return `${dateStr}T00:00:00`;

  try {
    const [timePart, meridian] = String(timeStr).trim().split(/\s+/);
    if (!timePart) return `${dateStr}T00:00:00`;

    let [hours, minutes = 0] = timePart.split(':').map(Number);
    if (meridian === 'PM' && hours !== 12) hours += 12;
    if (meridian === 'AM' && hours === 12) hours = 0;

    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day, hours, minutes, 0);

    if (Number.isNaN(date.getTime())) throw new Error('Invalid booking time');
    return formatLocalDateTime(date);
  } catch {
    return `${dateStr}T12:00:00`;
  }
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
