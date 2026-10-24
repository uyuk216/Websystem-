import type { RuntimeDriver } from 'platform';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { isAppBlocked } from './gate.js';
import { runNextOutbox, type OutboxKind } from './outbox.js';
import type { securityOutbox } from '../db/schema.js';
import type { WakeLock } from '../apps/wake.js';

export type OutboxHandlers = Partial<Record<OutboxKind, (payload: Record<string, unknown>, row: typeof securityOutbox.$inferSelect, tx: Tx, now: Date) => Promise<void>>>;

/** コンテナ停止の副作用。通知・配送の handler は後続の Task が足す。 */
export function stopAppHandlers(driver: Pick<RuntimeDriver, 'stop'>, lock?: WakeLock): OutboxHandlers {
  return {
    stop_app: async (payload, _row, tx) => {
      const appId = payload.appId;
      if (typeof appId !== 'string') throw new TypeError('stop_app payload without appId');
      const stop = async () => { if (await isAppBlocked(tx, appId)) await driver.stop(appId); };
      await (lock ? lock(appId, stop) : stop());
    },
  };
}

export interface DrainResult { done: number; failed: number }

/**
 * 期限の来た outbox を処理する（worker が定期的に呼ぶ）。handler の無い種類は触らず残す。
 * 失敗した副作用は次回時刻を延ばして残る。遮断そのものは事件の commit 時点で有効なので、停止の失敗では外れない。
 */
export async function drainSecurityOutbox(db: Db, handlers: OutboxHandlers, opts: { now?: Date; limit?: number; queue?: 'urgent' | 'normal' } = {}): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const kinds = (Object.keys(handlers) as OutboxKind[]).filter((k) => handlers[k]);
  const out: DrainResult = { done: 0, failed: 0 };
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const r = await withSystem(db, (tx) => runNextOutbox(tx, kinds, now, async (row) => { await handlers[row.kind]!(row.payload as Record<string, unknown>, row, tx, now); }, opts.queue));
    if (r === null) break;
    out[r]++;
  }
  return out;
}
