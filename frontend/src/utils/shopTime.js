// The shop runs on Asia/Manila (UTC+8, no daylight saving). Bookings are stored as real
// instants, so any screen that places them on a clock or a calendar day must read the
// SHOP's wall time, never the viewer's device time. Otherwise a 2 PM booking lands in the
// wrong hour row for an admin whose device is in another timezone.
export const SHOP_TIMEZONE = 'Asia/Manila';
const SHOP_OFFSET_MS = 8 * 60 * 60 * 1000;

const asShopWall = (value) => new Date(new Date(value).getTime() + SHOP_OFFSET_MS);

/** 'YYYY-MM-DD' of the instant, as read on the shop's clock. */
export const shopDateString = (value = new Date()) => {
  const d = asShopWall(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

/** Hour of day with minutes as a fraction (14.5 = 2:30 PM), on the shop's clock. */
export const shopHourValue = (value) => {
  const d = asShopWall(value);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};

/** The instant at which the shop's clock reads dateStr + hour (hour may be negative or above 24). */
export const shopWallToDate = (dateStr, hour = 0) => {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0) + hour * 3600000 - SHOP_OFFSET_MS);
};
