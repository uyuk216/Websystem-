import { planGuidance } from './plan-guidance.js';
import { and, eq, sql } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { STATIC_LIMITS } from 'shared';
import { resolveEntitlements } from '../grants/entitlements.js';
import { decryptEmail } from '../crypto/email.js';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { accounts, apps, owners, teamMembers, transferUsage } from '../db/schema.js';
import { UUID } from '../auth/cross-device.js';
import type { Mailer } from '../mail/mailer.js';

/** Calendar month in UTC, 'YYYY-MM'. Quotas reset on the UTC month boundary. */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

export function secondsUntilNextMonth(d: Date): number {
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - d.getTime()) / 1000));
}

export const FLUSH_INTERVAL_MS = 10_000;
export const LIMIT_CACHE_MS = 30_000;
const WARN_RATIO = 0.8;

export interface TransferMeterOptions {
  db: Db;
  /** Without a mailer (or key) the 80% flag is still set but no mail is sent. */
  mailer?: Mailer;
  emailKey?: Buffer;
  limitBytes?: number;
  now?: () => Date;
  flushIntervalMs?: number;
  limitCacheMs?: number;
}

export interface TransferMeter {
  /** Adds bytes written to a client (in memory only). */
  record(appId: string, bytes: number): void;
  /** Writes pending counters to transfer_usage (ON CONFLICT bytes = bytes + EXCLUDED.bytes). */
  flush(): Promise<void>;
  /** True when this month's transfer (stored + pending) reached the limit. Cached 30s. */
  isBlocked(appId: string): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function createTransferMeter(opts: TransferMeterOptions): TransferMeter {
  const { db } = opts;
  // 上限はアプリごと（プランの設定の上書きと、イベントブースト中の上乗せ）。30 秒だけ覚える。`limitBytes` を渡すとそれを使う（テスト用）。
  const limitCache = new Map<string, { bytes: number; at: number }>();
  async function limitFor(appId: string): Promise<number> {
    if (opts.limitBytes !== undefined) return opts.limitBytes;
    const t0 = now().getTime();
    const hit = limitCache.get(appId);
    if (hit && t0 - hit.at < cacheMs) return hit.bytes;
    const [a] = await withSystem(db, (tx) => tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId)));
    const bytes = a ? (await resolveEntitlements(db, a.ownerId, now(), { appId })).static.monthlyTransferBytes : STATIC_LIMITS.monthlyTransferBytes;
    limitCache.set(appId, { bytes, at: t0 });
    return bytes;
  }
  const now = opts.now ?? (() => new Date());
  const cacheMs = opts.limitCacheMs ?? LIMIT_CACHE_MS;
  // month -> appId -> bytes. Keyed by month so a flush after midnight cannot bill the wrong month.
  let pending = new Map<string, Map<string, number>>();
  const cache = new Map<string, { month: string; blocked: boolean; at: number }>();
  let timer: NodeJS.Timeout | undefined;
  let flushing: Promise<void> = Promise.resolve();
  const mails = new Set<Promise<void>>();

  function record(appId: string, bytes: number): void {
    if (!(bytes > 0)) return;
    const month = monthKey(now());
    let m = pending.get(month);
    if (!m) pending.set(month, (m = new Map()));
    m.set(appId, (m.get(appId) ?? 0) + bytes);
  }

  function requeue(month: string, appId: string, bytes: number): void {
    let m = pending.get(month);
    if (!m) pending.set(month, (m = new Map()));
    m.set(appId, (m.get(appId) ?? 0) + bytes);
  }

  async function flushOnce(): Promise<void> {
    const batch = pending;
    pending = new Map();
    for (const [month, perApp] of batch) {
      for (const [appId, bytes] of perApp) {
        try {
          const limit = await limitFor(appId);
          const warn = await withSystem(db, async (tx) => {
            const [row] = await tx.insert(transferUsage).values({ appId, month, bytes })
              .onConflictDoUpdate({ target: [transferUsage.appId, transferUsage.month], set: { bytes: sql`${transferUsage.bytes} + excluded.bytes` } })
              .returning({ bytes: transferUsage.bytes });
            if (!row || row.bytes < limit * WARN_RATIO) return null;
            // Atomic "first one wins": only the caller that flips the flag sends the mail.
            const flipped = await tx.update(transferUsage).set({ notified80: true })
              .where(and(eq(transferUsage.appId, appId), eq(transferUsage.month, month), eq(transferUsage.notified80, false)))
              .returning({ appId: transferUsage.appId });
            return flipped.length > 0 ? row.bytes : null;
          });
          if (warn !== null) notifyOwner(appId, warn, limit);
        } catch (e) {
          if ((e as { code?: string; cause?: { code?: string } }).code === '23503' || (e as { cause?: { code?: string } }).cause?.code === '23503') continue; // app deleted
          console.error('transfer flush failed', appId, e);
          requeue(month, appId, bytes);
        }
      }
    }
  }

  function flush(): Promise<void> {
    // Serialise flushes inside one process (timer + shutdown).
    flushing = flushing.then(flushOnce, flushOnce);
    return flushing;
  }

  function notifyOwner(appId: string, used: number, limit: number): void {
    const { mailer, emailKey } = opts;
    if (!mailer || !emailKey) return;
    // Fire-and-forget; Promise.resolve().then also catches synchronous throws.
    const p: Promise<void> = Promise.resolve().then(async () => {
      const target = await withSystem(db, async (tx) => {
        const [a] = await tx.select({ name: apps.name, ownerId: apps.ownerId, kind: owners.kind, accountId: owners.accountId, teamId: owners.teamId })
          .from(apps).innerJoin(owners, eq(owners.id, apps.ownerId)).where(eq(apps.id, appId));
        if (!a) return null;
        let accountId = a.accountId;
        if (a.kind === 'team' && a.teamId) {
          const [m] = await tx.select({ accountId: teamMembers.accountId }).from(teamMembers)
            .where(and(eq(teamMembers.teamId, a.teamId), eq(teamMembers.role, 'owner')));
          accountId = m?.accountId ?? null;
        }
        if (!accountId) return null;
        const [acc] = await tx.select({ emailEnc: accounts.emailEnc, locale: accounts.locale }).from(accounts).where(eq(accounts.id, accountId));
        return acc ? { app: a.name, ownerId: a.ownerId, ...acc } : null;
      });
      if (!target) return;
      const locale: Locale = target.locale === 'en' ? 'en' : 'ja';
      const params = { app: target.app, limit: formatBytes(limit), used: formatBytes(used) };
      await mailer.sendMail(decryptEmail(target.emailEnc, emailKey), t(locale, 'transfer.warnSubject', params), t(locale, 'transfer.warnBody', params) + '\n\n' + await planGuidance(db, target.ownerId, locale));
    }).catch((err: unknown) => console.error('transfer 80% mail failed', appId, err));
    mails.add(p);
    void p.finally(() => mails.delete(p));
  }

  async function isBlocked(appId: string): Promise<boolean> {
    const at = now().getTime();
    const month = monthKey(now());
    const hit = cache.get(appId);
    if (hit && hit.month === month && at - hit.at < cacheMs) return hit.blocked;
    const [row] = await withSystem(db, (tx) =>
      tx.select({ bytes: transferUsage.bytes }).from(transferUsage).where(and(eq(transferUsage.appId, appId), eq(transferUsage.month, month))));
    const total = (row?.bytes ?? 0) + (pending.get(month)?.get(appId) ?? 0);
    const blocked = total >= (await limitFor(appId));
    cache.set(appId, { month, blocked, at });
    return blocked;
  }

  return {
    record,
    flush,
    isBlocked,
    start() {
      if (timer) return;
      timer = setInterval(() => void flush().catch((e) => console.error('transfer flush failed', e)), opts.flushIntervalMs ?? FLUSH_INTERVAL_MS);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await flush();
      // Let in-flight 80% notifications finish, but never hold shutdown for long.
      let t: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...mails]), new Promise((r) => { t = setTimeout(r, 5000); })]);
      clearTimeout(t);
    },
  };
}

export interface Usage {
  month: string;
  bytes: number;
  limitBytes: number;
}

/** Current-month transfer for an app the account may see (RLS); null when not found. */
export async function getUsage(db: Db, accountId: string, appId: string, at: Date = new Date()): Promise<Usage | null> {
  if (!UUID.test(appId)) return null;
  const month = monthKey(at);
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ id: apps.id, ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return null;
    const [u] = await tx.select({ bytes: transferUsage.bytes }).from(transferUsage)
      .where(and(eq(transferUsage.appId, appId), eq(transferUsage.month, month)));
    return { month, bytes: u?.bytes ?? 0, ownerId: a.ownerId };
  }).then(async (r) => (r ? { month: r.month, bytes: r.bytes, limitBytes: (await resolveEntitlements(db, r.ownerId, at, { appId })).static.monthlyTransferBytes } : null));
}
