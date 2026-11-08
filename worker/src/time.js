// Paris time helpers — Workers run in UTC; every "today" and every Navitia
// timestamp is Europe/Paris local. Convert explicitly or comparisons drift
// by 1-2 h.

// Paris-local "today" key (YYYY-MM-DD) + minute-of-day.
export function parisNow() {
  const now = new Date();
  const dateKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const { h, m } = parisHourMin(now.getTime());
  return { dateKey, minutes: h * 60 + m };
}

function parisOffsetMs(utcDate = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(utcDate).map(p => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - utcDate.getTime();
}

// Navitia "YYYYMMDDTHHmmss" (Paris local) → epoch ms
export function parseNavitiaDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return utcGuess - parisOffsetMs(new Date(utcGuess));
}

// epoch ms → { h, m } in Paris local time
export function parisHourMin(epochMs) {
  const fmt = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return { h: +parts.hour % 24, m: +parts.minute };
}

// "YYYYMMDDTHHmmss" for a given Paris local hour today
export function navitiaDtParisToday(hour, minute = 0) {
  const [y, mo, d] = parisNow().dateKey.split('-');
  const pad = (n) => String(n).padStart(2, '0');
  return `${y}${mo}${d}T${pad(hour)}${pad(minute)}00`;
}

// Strict YYYY-MM-DD that is also a real calendar date.
export function isDateKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(s + 'T00:00:00Z');
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}
