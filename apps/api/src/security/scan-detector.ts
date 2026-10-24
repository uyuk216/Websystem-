/** 本体ドメインへの探索（/.git/config、/wp-admin 等）。一般のドットファイルや管理画面の探索パスだけを対象にする。 */
const SCAN_PREFIXES = [
  '/.git', '/.svn', '/.hg', '/.aws', '/.ssh', '/.docker', '/.env', '/.ds_store', '/wp-admin', '/wp-login.php', '/wp-content', '/wp-includes', '/xmlrpc.php',
  '/phpmyadmin', '/pma', '/cgi-bin', '/vendor/phpunit', '/actuator', '/server-status', '/config.json', '/admin/login', '/.well-known/../',
];
export function isScanPath(rawPath: string): boolean {
  let p = rawPath.toLowerCase();
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return SCAN_PREFIXES.some((x) => p === x || p.startsWith(x.endsWith('/') ? x : `${x}/`) || p.startsWith(`${x}.`) || p.startsWith(`${x}?`));
}

/**
 * 送信元ごとに、時間窓内の「異なる探索パスの数」を数える。しきい値に達した窓で 1 回だけ true。
 * 送信元は信頼できる IP の HMAC だけ（取得不能な `unknown` は呼び出し側が渡さない＝共有の unknown を遮断しない）。
 * 状態は上限つき（古い窓から捨てる）。時計は注入できる。
 */
export class ScanDetector {
  private windows = new Map<string, { start: number; paths: Set<string>; fired: boolean }>();
  constructor(private o: { windowMs?: number; threshold?: number; maxSources?: number; now?: () => number } = {}) {}
  record(sourceKey: string, path: string): { fire: boolean; windowStart: number } {
    const now = (this.o.now ?? Date.now)();
    const windowMs = this.o.windowMs ?? 60_000, threshold = this.o.threshold ?? 5, max = this.o.maxSources ?? 10_000;
    let w = this.windows.get(sourceKey);
    if (!w || now - w.start >= windowMs) {
      if (!w && this.windows.size >= max) {
        for (const [k, v] of this.windows) { if (now - v.start >= windowMs) this.windows.delete(k); }
        if (this.windows.size >= max) this.windows.delete(this.windows.keys().next().value as string);
      }
      w = { start: now, paths: new Set(), fired: false }; this.windows.set(sourceKey, w);
    }
    w.paths.add(path.toLowerCase().slice(0, 128));
    if (!w.fired && w.paths.size >= threshold) { w.fired = true; return { fire: true, windowStart: w.start }; }
    return { fire: false, windowStart: w.start };
  }
}
