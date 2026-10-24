import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * IPv4 / IPv6 を 1 つの形に正規化する（IPv4-mapped IPv6 は IPv4 へ、IPv6 は 8 グループの小文字 16 進、ゾーン ID は除く）。
 * IP でない文字列は null。ブロックの検索はこの正規形の HMAC（`hashIp`）で行い、生の IP は保存しない。
 */
export function normalizeIp(raw: string): string | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  const v = isIP(s);
  if (v === 4) return s.split('.').map((x) => String(Number(x))).join('.');
  if (v !== 6) return null;
  // 末尾が IPv4 表記（::ffff:1.2.3.4）なら 16 進 2 グループに直す。
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const o = tail[2]!.split('.').map(Number);
    s = `${tail[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const a = head ? head.split(':') : [];
  const b = rest === undefined ? [] : rest ? rest.split(':') : [];
  const groups = rest === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b];
  if (groups.length !== 8) return null;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((g) => g === 0) && n[5] === 0xffff) return `${n[6]! >> 8}.${n[6]! & 255}.${n[7]! >> 8}.${n[7]! & 255}`;
  return n.map((g) => g.toString(16)).join(':');
}

/** 正規化した IP の HMAC-SHA256（64 桁 16 進）。IP でなければ null。 */
export function hashIp(ip: string, key: Buffer): string | null {
  const n = normalizeIp(ip);
  return n === null ? null : createHmac('sha256', key).update(`ip:${n}`).digest('hex');
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
/** localhost / 内部ネットワーク（ループバック・プライベート・リンクローカル・CGNAT・ULA）からの接続か。内部の判定口はここからだけ受ける。 */
export function isInternalPeer(addr: string | undefined): boolean {
  const n = addr ? normalizeIp(addr) : null;
  if (n === null) return false;
  if (!n.includes(':')) return PRIVATE_V4.some((r) => r.test(n));
  return n === '0:0:0:0:0:0:0:1' || /^f[cd]/.test(n) || /^fe[89ab]/.test(n);
}
