import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { collectLogs } from 'platform';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { maskIp } from '../auth/login-history.js';
import { accessLogs, apps } from '../db/schema.js';
import { getRunInputs } from './databases.js';
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
  let dropped = 0;
  let lastWarn = 0;
  function noteDropped(n: number): void {
    dropped += n;
    const now = Date.now();
    if (now - lastWarn >= 60_000) { lastWarn = now; console.warn(`access log buffer full: dropped ${dropped} rows so far`); }
  }
  async function flush(): Promise<void> {
    if (buf.length === 0) return;
    const rows = buf;
    buf = [];
    try {
      await withSystem(db, async (tx) => { for (let i = 0; i < rows.length; i += 500) await tx.insert(accessLogs).values(rows.slice(i, i + 500)); });
    } catch (e) {
      console.error('access log write failed', e);
      // Re-queue at the front (older first); beyond the cap the oldest rows are dropped and counted.
      const merged = rows.concat(buf);
      const over = merged.length - max;
      buf = over > 0 ? merged.slice(over) : merged;
      if (over > 0) noteDropped(over);
    }
  }
  return {
    record(e: AccessEntry): void {
      if (buf.length >= max) { noteDropped(1); return; } // shed load rather than grow without bound
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
  const cutoff = new Date(now.getTime() - ACCESS_LOG_RETENTION_MS);
  let total = 0;
  for (;;) {
    const ids = await withSystem(db, (tx) => tx.select({ id: accessLogs.id }).from(accessLogs).where(lt(accessLogs.createdAt, cutoff)).limit(10_000));
    if (ids.length === 0) return total;
    await withSystem(db, (tx) => tx.delete(accessLogs).where(inArray(accessLogs.id, ids.map((r) => r.id))));
    total += ids.length;
  }
}

export async function listAccessLogs(db: Db, accountId: string, appId: string, limit = 100) {
  if (!UUID.test(appId)) return { error: 'not_found' as const };
  const n = Math.min(MAX_TAIL, Math.max(1, Math.floor(limit) || 100));
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
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
  const { secrets } = await getRunInputs(db, rt, appId);
  return { lines: await collectLogs(rt.driver, appId, a.active, secrets, n) };
}
