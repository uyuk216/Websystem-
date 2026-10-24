import type { Db } from 'api/db';
import { blockedAppIds, blockedIpHashes } from 'api/security-gate';

export interface TrackedConnection {
  appId: string;
  /** 接続元 IP の HMAC（生の IP は持たない）。 */
  ipHash: string | null;
  /** 接続を閉じる（WebSocket は socket を壊し、HTTP の応答は上流を中断する）。 */
  close(): void;
}

/**
 * 開いている WebSocket・長い応答の登録簿。遮断が commit されたとき、過去に許可した接続も閉じる。
 * `recheck` は DB の変更通知（LISTEN）でも定期（既定 1 秒）でも呼ばれる。複数の edge のどれかで通知が欠けても、
 * 次の定期の再照合で閉じる。判定不能時も接続を閉じるが、永続的なブロックは作らない。
 */
export class ConnectionRegistry {
  private readonly open = new Set<TrackedConnection>();
  private timer: NodeJS.Timeout | undefined;

  get size(): number { return this.open.size; }

  add(c: TrackedConnection): () => void {
    this.open.add(c);
    return () => { this.open.delete(c); };
  }

  /** 遮断中の接続を閉じて、閉じた数を返す。 */
  async recheck(db: Db): Promise<number> {
    if (this.open.size === 0) return 0;
    const snapshot = [...this.open];
    let apps: Set<string>;
    let ips: Set<string>;
    try {
      apps = await blockedAppIds(db, [...new Set(snapshot.map((c) => c.appId))]);
      ips = await blockedIpHashes(db, [...new Set(snapshot.flatMap((c) => (c.ipHash ? [c.ipHash] : [])))]);
    } catch (e) {
      console.error('connection recheck failed', e);
      for (const c of snapshot) {
        this.open.delete(c);
        try { c.close(); } catch (e) { console.error('close unavailable connection failed', e); }
      }
      return snapshot.length;
    }
    let n = 0;
    for (const c of snapshot) {
      if (!apps.has(c.appId) && !(c.ipHash && ips.has(c.ipHash))) continue;
      this.open.delete(c);
      try { c.close(); } catch (e) { console.error('close blocked connection failed', e); }
      n++;
    }
    return n;
  }

  /** 定期の再照合を始める。止める関数を返す。 */
  start(db: Db, intervalMs = 1000): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > 1000) throw new RangeError('recheck interval must be 1..1000ms');
    clearInterval(this.timer);
    const timer = setInterval(() => { void this.recheck(db); }, intervalMs);
    this.timer = timer;
    this.timer.unref();
    return () => clearInterval(timer);
  }
}
