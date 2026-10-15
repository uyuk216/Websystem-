/** Host -> app name. Lowercases, ignores the port, accepts exactly one label under `baseDomain`. */
export function resolveSite(host: string, baseDomain: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return null; // IPv6 literal
  const colon = h.lastIndexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  if (h.endsWith('.')) h = h.slice(0, -1);
  const base = baseDomain.trim().toLowerCase().replace(/\.$/, '');
  if (!base || !h.endsWith(`.${base}`)) return null;
  const label = h.slice(0, -(base.length + 1));
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}

export type ParsedPath = { segments: string[]; dir: boolean } | { status: 400 | 404 };

/**
 * Raw request path -> storage path segments. Each segment is percent-decoded exactly once, NFC-normalised.
 * 400: bad encoding, NUL, `..`, or a decoded segment that contains a separator (`%2f`, `%5c`).
 * 404: any other segment starting with `.`, except `.well-known`.
 */
export function parsePath(rawPath: string): ParsedPath {
  const raw = rawPath.split('/').filter((s, i, all) => s !== '' || i === all.length - 1);
  const dir = rawPath.endsWith('/');
  const segments: string[] = [];
  for (const r of raw) {
    if (r === '') continue;
    let s: string;
    try {
      s = decodeURIComponent(r);
    } catch {
      return { status: 400 };
    }
    s = s.normalize('NFC');
    if (s.includes('\0') || s.includes('/') || s.includes('\\') || s === '..') return { status: 400 };
    segments.push(s);
  }
  if (segments.some((s) => s.startsWith('.') && s !== '.well-known')) return { status: 404 };
  return { segments, dir };
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', wasm: 'application/wasm',
  webmanifest: 'application/manifest+json', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Content-Type from the extension (unknown -> application/octet-stream). */
export function contentTypeFor(name: string): string {
  return TYPES[extensionOf(name)] ?? 'application/octet-stream';
}

/** Storage keys to try, in order, for a parsed path (relative to the site prefix). */
export function candidates(p: { segments: string[]; dir: boolean }): string[] {
  const base = p.segments.join('/');
  if (p.segments.length === 0) return ['index.html'];
  if (p.dir) return [`${base}/index.html`];
  const last = p.segments[p.segments.length - 1]!;
  if (extensionOf(last) !== '') return [base];
  return [base, `${base}.html`, `${base}/index.html`];
}

/** Picks ja or en from Accept-Language by q-value; defaults to ja (the platform's primary language). */
export function pickLocale(header: string | undefined): 'ja' | 'en' {
  let best: { lang: 'ja' | 'en'; q: number } | null = null;
  for (const part of (header ?? '').split(',')) {
    const [tag = '', ...params] = part.trim().split(';');
    const lang = tag.trim().toLowerCase().split('-')[0];
    if (lang !== 'ja' && lang !== 'en') continue;
    const qp = params.map((x) => x.trim()).find((x) => x.startsWith('q='));
    const q = qp ? Number(qp.slice(2)) : 1;
    if (Number.isNaN(q) || q <= 0) continue;
    if (!best || q > best.q) best = { lang, q };
  }
  return best?.lang ?? 'ja';
}
