// Outbound URL filter for user-supplied targets (/llm endpoint, RSS sources):
// https only, named public hosts only — no IP literals, no local names.

export function isPublicHttpsUrl(target) {
  let u;
  try { u = new URL(target); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.')) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return false;
  if (h.endsWith('.local') || h.endsWith('.internal')) return false;
  // IPv6 literals keep their brackets in URL.hostname; the parser normalises
  // decimal/hex/octal IPv4 spellings to dotted quads.
  if (h.startsWith('[')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.x]+$/.test(h)) return false;
  return true;
}

// GET a public URL, following redirects by hand so each hop is re-checked —
// an allowed URL redirecting to a blocked one must not bypass the filter.
export async function fetchPublic(target, init = {}, maxHops = 3) {
  let current = target;
  for (let hop = 0; ; hop++) {
    if (!isPublicHttpsUrl(current)) throw new Error('target not allowed');
    const resp = await fetch(current, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
    if (resp.body) await resp.body.cancel().catch(() => {});
    const loc = resp.headers.get('Location');
    if (!loc || hop >= maxHops) throw new Error('too many redirects');
    current = new URL(loc, current).toString();
  }
}
