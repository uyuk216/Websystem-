import { DYNAMIC_LIMITS } from 'shared';
import type { Db, Tx } from '../db/client.js';
import { resolveEntitlements } from '../grants/entitlements.js';

/**
 * コンテナを起動するときの上限（メモリ・CPU・PID）。オーナーのプラン（Student / Starter）とアプリ宛てのイベントブーストから決める。
 * 付与が切れて「なし」でも猶予の間は動き続けるので、0 のときは Student の既定値を使う。
 */
export async function runLimitsFor(db: Db | Tx, ownerId: string, appId: string, at: Date = new Date()): Promise<{ memoryMb: number; cpu: number; pids: number }> {
  const d = (await resolveEntitlements(db, ownerId, at, { appId })).dynamic;
  return { memoryMb: d.memoryMb || DYNAMIC_LIMITS.memoryMb, cpu: d.cpu || DYNAMIC_LIMITS.cpu, pids: d.pids || DYNAMIC_LIMITS.pids };
}
