// Date / time helpers
export function formatDateLong(d) {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(d);
}

export function timeAgo(date) {
  if (!date || Number.isNaN(date.getTime?.())) return '';
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `il y a ${Math.floor(diff / 86400)} j`;
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(date);
}

// Minutes until a date, can be negative
export function minutesUntil(date) {
  return Math.round((date.getTime() - Date.now()) / 60000);
}

// String / DOM helpers
export function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Only allow http(s) URLs in href/style sinks — feed data is third-party.
export function safeUrl(url) {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url, location.href);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.toString();
  } catch {}
  return '';
}

// For CSS url('...') contexts: https-only and quote/paren-free.
export function safeCssUrl(url) {
  const s = safeUrl(url);
  if (!s || !s.startsWith('https:')) return '';
  if (/['"()\\]/.test(s)) return '';
  return s;
}

export function debounce(fn, delay) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

// Generate a short unique id
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Try to safely parse JSON, return fallback on failure
export function safeJSON(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Haptic feedback (Android only; iOS no-op)
export function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch {}
}

// Fetch with timeout
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(t);
  }
}
