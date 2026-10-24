import { isInternalPeer, normalizeIp } from './ip.js';

/**
 * 訪問者のアドレス。信頼するプロキシは `hops` 段（EDGE_TRUSTED_PROXY_HOPS / TRUSTED_PROXY_HOPS）。
 * - `hops` が 0、ヘッダーが無い、足りない、接続元が内部ネットワークでない（プロキシを通らない直アクセス）、
 *   またはヘッダーの値が IP でないときは、接続元のソケットのアドレスを使う。
 * - それ以外は X-Forwarded-For の右から `hops` 番目（プロキシが付け足した値）。左側はクライアントが書けるので見ない。
 * IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 に直す。何も得られなければ null。
 */
export function trustedClientIp(xff: string | string[] | undefined, socketAddr: string | undefined, hops: number): string | null {
  const peer = socketAddr ? (normalizeIp(socketAddr) ?? socketAddr) : null;
  const header = Array.isArray(xff) ? xff.join(',') : xff;
  if (hops > 0 && header && isInternalPeer(socketAddr)) {
    const parts = header.split(',').map((p) => p.trim()).filter(Boolean);
    const hit = parts[parts.length - hops];
    const n = hit ? normalizeIp(hit) : null;
    if (n) return n;
  }
  return peer;
}
