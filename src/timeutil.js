// Local-time helpers. Everything user-facing is America/New_York; everything stored
// is either a YYYY-MM-DD local date string or a full ISO instant. Mixing those two up
// is the classic way to get an off-by-one-day bug in a calendar app, so the conversions
// all live here.

export const MS_PER_DAY = 86400000;

export function ymd(date, tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function hhmm(date, tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function prettyTime(date, tz = 'America/New_York') {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date).toLowerCase();
}

export function weekday(dateStr) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
    .format(new Date(`${dateStr}T12:00:00Z`));
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / MS_PER_DAY);
}

export function dateRange(start, end) {
  const out = [];
  let cur = start;
  while (cur <= end) { out.push(cur); cur = addDays(cur, 1); }
  return out;
}

export function todayLocal(tz = 'America/New_York') {
  return ymd(new Date(), tz);
}

export function nowIso() {
  return new Date().toISOString();
}

// Month-day key ('11-18') used to look up climate normals.
export const monthDay = (dateStr) => dateStr.slice(5);
