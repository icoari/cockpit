// Minimal XML/HTML text helpers for feed parsing and disruption messages.

export function decodeXml(s) {
  // Single pass — sequential replaces double-decode nested escapes like
  // "&amp;lt;" (or numeric "&#38;lt;") into real markup characters.
  const named = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|quot|apos|amp));/gi, (_, dec, hex, name) => {
    try {
      if (dec) return String.fromCodePoint(parseInt(dec, 10));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return named[name.toLowerCase()];
    } catch { return _; }
  });
}

export function cleanXmlText(s) {
  // strip CDATA wrappers
  return s.replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
}

// Atom entries can carry several <link> tags (self, enclosure, alternate)
// with attributes in any order and either quote style. Prefer
// rel="alternate", fall back to the first link that isn't self/enclosure.
export function pickAtomLink(entryXml) {
  const tags = [...entryXml.matchAll(/<link\b[^>]*>/g)].map(m => m[0]);
  let fallback = '';
  for (const tag of tags) {
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (!href) continue;
    const rel = tag.match(/rel\s*=\s*["']([^"']+)["']/)?.[1] || '';
    if (rel === 'alternate' || rel === '') {
      if (rel === 'alternate') return href;
      if (!fallback) fallback = href;
    }
  }
  return fallback;
}

export function stripHtml(s) {
  return cleanXmlText(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
