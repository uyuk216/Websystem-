import { and, desc, eq, lt } from 'drizzle-orm';
import { collectLogs } from 'platform';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { maskIp } from '../auth/login-history.js';
import { accessLogs, apps } from '../db/schema.js';
import { getAppEnvForRun } from './env-vars.js';
import { mayManage } from './apps.js';
import type { DynamicRuntime } from '../ingest/dynamic.js';

export const ACCESS_LOG_RETENTION_MS = 30 * 86400_000;
export const MAX_TAIL = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UaKind = 'browser' | 'bot' | 'cli' | 'other';
export function uaKind(ua: string | undefined | null): UaKind {
  if (!ua) return 'other';
  if (/bot|crawl|spider|slurp|facebookexternalhit|preview/i.test(ua)) return 'bot';
  if (/^(curl|wget|httpie|python-requests|node|go-http-client|okhttp|axios|java)/i.test(ua)) return 'cli';
  if (/mozilla|chrome|safari|firefox|edg/i.test(ua)) return 'browser';
  return 'other';
}

export interface AccessEntry { appId: string; method: string; path: string; status: number; bytes: number; userAgent?: string | null; referrer?: string | null; ip: string; at?: Date }

/** Referrer reduced to its origin (query and path can hold tokens). */
const referrerOrigin = (r: string | null | undefined): string | null => {
  if (!r) return null;
  try { return new URL(r).origin.slice(0, 200); } catch { return null; }
};

/** Collects access log rows in memory and writes them in batches; never blocks or fails a request. */
export function createAccessLogger(db: Db, opts: { flushMs?: number; maxBuffer?: number } = {}) {
  let buf: Array<typeof accessLogs.$inferInsert> = [];
  const max = opts.maxBuffer ?? 5000;
  let timer: NodeJS.Timeout | undefined;
  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    const rows = buf;
    buf = [];
    try {
      await withSystem(db, async (tx) => { for (let i = 0; i < rows.length; i += 500) await tx.insert(accessLogs).values(rows.slice(i, i + 500)); });
    } catch (e) {
      console.error('access log write failed', e);
    }
  }
  return {
    record(e: AccessEntry): void {
      if (buf.length >= max) return; // shed load rather than grow without bound
      buf.push({
        appId: e.appId, createdAt: e.at ?? new Date(), method: e.method.slice(0, 16), path: e.path.slice(0, 2000), status: e.status,
        bytes: Math.max(0, Math.round(e.bytes)), uaKind: uaKind(e.userAgent), referrer: referrerOrigin(e.referrer), ipPrefix: maskIp(e.ip),
      });
    },
    flush,
    start(): void { timer ??= setInterval(() => { void flush(); }, opts.flushMs ?? 10_000); timer.unref(); },
    async stop(): Promise<void> { clearInterval(timer); timer = undefined; await flush(); },
  };
}
export type AccessLogger = ReturnType<typeof createAccessLogger>;

export async function purgeOldAccessLogs(db: Db, now: Date): Promise<number> {
  const rows = await withSystem(db, (tx) => tx.delete(accessLogs).where(lt(accessLogs.createdAt, new Date(now.getTime() - ACCESS_LOG_RETENTION_MS))).returning({ id: accessLogs.id }));
  return rows.length;
}

export async function listAccessLogs(db: Db, accountId: string, appId: string, limit = 100) {
  if (!UUID.test(appId)) return { error: 'not_found' as const };
  const n = Math.min(MAX_TAIL, Math.max(1, Math.floor(limit) || 100));
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    const logs = await tx.select({
      at: accessLogs.createdAt, method: accessLogs.method, path: accessLogs.path, status: accessLogs.status, bytes: accessLogs.bytes,
      uaKind: accessLogs.uaKind, referrer: accessLogs.referrer, ipPrefix: accessLogs.ipPrefix,
    }).from(accessLogs).where(eq(accessLogs.appId, appId)).orderBy(desc(accessLogs.createdAt)).limit(n);
    return { logs };
  });
}

/** Latest stdout/stderr lines of the active deployment (needs deploy permission), env values redacted. */
export async function getAppLogs(db: Db, rt: DynamicRuntime, accountId: string, appId: string, tail = MAX_TAIL) {
  if (!UUID.test(appId)) return { error: 'not_found' as const };
  const n = Math.min(MAX_TAIL, Math.max(1, Math.floor(tail) || MAX_TAIL));
  const a = await withAccount(db, accountId, async (tx) => {
    const [row] = await tx.select({ ownerId: apps.ownerId, active: apps.activeDeploymentId, kind: apps.kind }).from(apps).where(and(eq(apps.id, appId)));
    if (!row) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, row.ownerId))) return { error: 'forbidden' as const };
    return row;
  });
  if ('error' in a) return a;
  if (a.kind !== 'dynamic' || !a.active) return { lines: [] as string[] };
  const env = await getAppEnvForRun(db, rt.envKey, appId);
  return { lines: await collectLogs(rt.driver, appId, a.active, Object.values(env), n) };
}
