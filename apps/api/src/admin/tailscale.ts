/**
 * Tailscale source check for the admin API. A request is accepted only when its socket address is inside the
 * tailnet ranges (100.64.0.0/10, fd7a:115c:a1e0::/48) AND carries a Tailscale-User-Login header (set by
 * `tailscale serve`) that matches an active operator. Anything else is answered 404, so the port reveals nothing.
 */

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** Eight 16-bit groups, or null. Handles `::` and an embedded IPv4 tail. */
function parseIPv6(input: string): number[] | null {
  const s = input.split('%')[0]!;
  if (!s.includes(':')) return null;
  let tail: number[] = [];
  let head = s;
  const lastColon = s.lastIndexOf(':');
  const v4 = parseIPv4(s.slice(lastColon + 1));
  if (v4) {
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    head = s.slice(0, lastColon + 1) + '0:0'; // placeholder keeps group counting simple; replaced below
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const gs = part.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const a = toGroups(halves[0]!);
  const b = halves.length === 2 ? toGroups(halves[1]!) : [];
  if (!a || !b) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - a.length - b.length;
    if (fill < 1) return null;
    groups = [...a, ...new Array<number>(fill).fill(0), ...b];
  } else {
    groups = a;
  }
  if (groups.length !== 8) return null;
  if (v4) groups = [...groups.slice(0, 6), ...tail];
  return groups;
}

export function isTailscaleAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const v4 = parseIPv4(ip);
  if (v4) return v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127;
  const g = parseIPv6(ip);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) is judged by its IPv4 part.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const hi = g[6]!;
    return hi >> 8 === 100 && ((hi & 0xff) >= 64 && (hi & 0xff) <= 127);
  }
  return g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0;
}

export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = parseIPv4(mapped ? mapped[1]! : ip);
  return !!v4 && v4[0] === 127;
}

export interface TailscalePolicy {
  /** When false (dev/test only, refused in production by loadConfig) the source address is not checked. */
  required: boolean;
  /** Dev only: treat loopback as a tailnet address. */
  devLoopback: boolean;
}

export function sourceAllowed(ip: string | undefined, policy: TailscalePolicy): boolean {
  if (!policy.required) return true;
  if (isTailscaleAddress(ip)) return true;
  return policy.devLoopback && isLoopback(ip);
}
