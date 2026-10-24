import { createHmac } from 'node:crypto';
import type { HoneytokenPlacement, Detection } from 'platform';
import type { Db } from '../db/client.js';
import { handleSecuritySignal } from './incidents.js';
import { hashIp } from './ip.js';
import { buildSignal } from './signals.js';

/**
 * 罠の使用を事件にする。信頼できる IP（HMAC）が取れたときだけその IP を即遮断（高）。取れないとき（`unknown` 等）は共有の
 * unknown を遮断せず、配置 ID に固有の仮の対象で低（運営通知のみ）。証拠は種別・検知経路・匿名の配置 ID だけで、
 * 本文・パスワード・提示された鍵の値は渡さない。同じ (配置, IP) の再使用は重複として 1 件のまま（最優先通知は 1 回）。
 */
export async function fireHoneytoken(deps: { db: Db; hashKey: Buffer; now?: () => Date }, placement: HoneytokenPlacement, ip: string | null, via: Detection): Promise<{ incidentId: string; attributed: boolean }> {
  const ipHash = ip ? hashIp(ip, deps.hashKey) : null;
  const target = ipHash ?? createHmac('sha256', deps.hashKey).update(`trap-unattributed:${placement.placementId}`).digest('hex');
  const r = await handleSecuritySignal(deps.db, buildSignal({
    source: 'honeytoken', sourceEventId: `${placement.placementId}:${target.slice(0, 24)}`, ruleVersion: '1', occurredAt: (deps.now ?? (() => new Date()))(),
    severity: ipHash ? 'high' : 'low', target: { kind: 'ip', ipHash: target }, reasonCode: `trap.${placement.kind}`,
    evidence: { tokenKind: placement.kind, category: via, note: placement.placementId },
  }));
  return { incidentId: r.incidentId, attributed: ipHash !== null };
}
