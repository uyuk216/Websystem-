import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { securityBlocks } from '../db/schema.js';
import { hashIp } from './ip.js';

export type GateScope = 'app' | 'account' | 'ip';
export type GateVerdict = { allow: true } | { allow: false; scope: GateScope; reasonCode: string };

export interface GateInput {
  appId?: string;
  /** 省略すると、アプリのオーナー（アカウント所有）から引く。 */
  accountId?: string;
  /** 生の IP。比較は HMAC（`hashKey`）で、保存も出力もしない。 */
  clientIp?: string;
  hashKey: Buffer;
}

/**
 * 共通の遮断判定。有効なブロック理由（解除されていない `security_blocks`）が、アプリ・アカウント・IP のどれかに当たれば拒否。
 * 許可の結果はキャッシュしない（事件の commit 後、次の判定から効く）。DB を引けないときは例外を投げ、呼び出し側が 503 にする。
 */
export async function securityGate(db: Db | Tx, input: GateInput): Promise<GateVerdict> {
  const ipHash = input.clientIp ? hashIp(input.clientIp, input.hashKey) : null;
  if (!input.appId && !input.accountId && !ipHash) return { allow: true };
  return withSystem(db, async (tx) => {
    const account = input.accountId ? sql`${input.accountId}::uuid` : input.appId ? sql`(SELECT coalesce(o.account_id, (SELECT m.account_id FROM team_members m WHERE m.team_id = o.team_id AND m.role = 'owner' LIMIT 1)) FROM apps a JOIN owners o ON o.id = a.owner_id WHERE a.id = ${input.appId}::uuid)` : sql`NULL::uuid`;
    const frozen = await tx.execute(sql`SELECT 1 FROM usage_states u JOIN owners o ON o.id = u.owner_id WHERE u.reasons @> ARRAY['security_freeze']::text[] AND (o.account_id = ${account} OR o.id = (SELECT owner_id FROM apps WHERE id = ${input.appId ?? null}::uuid)) LIMIT 1`);
    if (frozen.length) return { allow: false as const, scope: 'account' as const, reasonCode: 'security_freeze' };
    const conds = [
      input.appId ? and(eq(securityBlocks.targetKind, 'app'), eq(securityBlocks.appId, input.appId)) : undefined,
      input.accountId ? and(eq(securityBlocks.targetKind, 'account'), eq(securityBlocks.accountId, input.accountId)) : undefined,
      input.appId && !input.accountId
        ? and(eq(securityBlocks.targetKind, 'account'), eq(securityBlocks.accountId, account))
        : undefined,
      ipHash ? and(eq(securityBlocks.targetKind, 'ip'), eq(securityBlocks.ipHash, ipHash)) : undefined,
    ].filter((c) => c !== undefined);
    const [hit] = await tx.select({ scope: securityBlocks.targetKind, reasonCode: securityBlocks.reasonCode }).from(securityBlocks)
      .where(and(isNull(securityBlocks.releasedAt), or(...conds))).limit(1);
    return hit ? { allow: false as const, scope: hit.scope, reasonCode: hit.reasonCode } : { allow: true as const };
  });
}

/** アプリ（またはそのオーナーのアカウント）が遮断中か。起動・ロールバック・再デプロイの直前に使う。 */
export async function isAppBlocked(db: Db | Tx, appId: string): Promise<boolean> {
  return !(await securityGate(db, { appId, hashKey: Buffer.alloc(0) })).allow;
}

/** 与えたアプリのうち遮断中のもの（アプリ単位かオーナーのアカウント単位）。接続の再照合用に 1 回の問い合わせで引く。 */
export async function blockedAppIds(db: Db | Tx, appIds: readonly string[]): Promise<Set<string>> {
  if (appIds.length === 0) return new Set();
  return withSystem(db, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT a.id FROM apps a JOIN owners o ON o.id = a.owner_id
      LEFT JOIN team_members m ON m.team_id = o.team_id AND m.role = 'owner'
      WHERE a.id IN (${sql.join(appIds.map((id) => sql`${id}::uuid`), sql`, `)}) AND (
        EXISTS (SELECT 1 FROM security_blocks b WHERE b.released_at IS NULL AND (
          (b.target_kind = 'app' AND b.app_id = a.id) OR
          (b.target_kind = 'account' AND b.account_id = coalesce(o.account_id, m.account_id))))
        OR EXISTS (SELECT 1 FROM usage_states u JOIN owners frozen ON frozen.id = u.owner_id
          WHERE u.reasons @> ARRAY['security_freeze']::text[]
          AND (u.owner_id = a.owner_id OR frozen.account_id = coalesce(o.account_id, m.account_id))))`);
    return new Set(rows.map((r) => r.id));
  });
}

/** 与えた IP ハッシュのうち遮断中のもの。 */
export async function blockedIpHashes(db: Db | Tx, hashes: readonly string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const rows = await withSystem(db, (tx) => tx.select({ h: securityBlocks.ipHash }).from(securityBlocks)
    .where(and(isNull(securityBlocks.releasedAt), eq(securityBlocks.targetKind, 'ip'), inArray(securityBlocks.ipHash, [...hashes]))));
  return new Set(rows.map((r) => r.h!));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 遮断中・判定不能のときの日英ページ。月末で戻る転送量の上限（transfer.limit*）とは別の文言。 */
export function pausedPage(locale: Locale, kind: 'paused' | 'unavailable'): string {
  const title = t(locale, 'security.pausedTitle');
  const body = t(locale, kind === 'paused' ? 'security.pausedBody' : 'security.unavailableBody');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style></head><body><h1>${esc(title)}</h1><p>${esc(body)}</p></body></html>`;
}
