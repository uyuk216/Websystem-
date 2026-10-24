import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RuntimeDriver } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments, runtimeMinutes, runtimeUsage } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { rollback as rollbackReal } from '../src/apps/deployments.js';
import { rolloutDynamic as rolloutDynamicReal, type DynamicRuntime } from '../src/ingest/dynamic.js';
import { MONTHLY_LIMIT_MINUTES, jstMonthKey, purgeRuntimeMinutes, startRuntimeMetering } from '../src/usage/runtime-hours.js';

let n = 0;
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function setup(db: TestDb, blocked: boolean) {
  const [a] = await db.insert(accounts).values({ emailHash: `ri${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const [app] = await db.insert(apps).values({ ownerId, name: `ri-${n}`, kind: 'dynamic' }).returning();
  const [live] = await db.insert(deployments).values({ appId: app!.id, source: 'upload', status: 'live', sourceKey: 's', imageRef: 'img:live' }).returning();
  await db.update(apps).set({ activeDeploymentId: live!.id }).where(eq(apps.id, app!.id));
  if (blocked) await db.insert(runtimeUsage).values({ ownerId, period: jstMonthKey(new Date()), minutes: MONTHLY_LIMIT_MINUTES });
  return { accountId: a!.id, ownerId, appId: app!.id, liveId: live!.id };
}

function driver() {
  const calls = { starts: 0 };
  let port = 0;
  const d: RuntimeDriver = {
    async start() {
      calls.starts++;
      if (!port) {
        const s = createServer((_q, r) => r.end('ok'));
        await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
        servers.push(s);
        port = (s.address() as AddressInfo).port;
      }
      return { appId: '', deploymentId: '', containerId: 'c' };
    },
    async stop() {}, async stopDeployment() {},
    async status() { return port ? 'running' : 'stopped'; },
    async endpoint() { return port ? { host: '127.0.0.1', port } : null; },
    async logs() { return []; }, async runningCount() { return []; },
  };
  return { d, calls };
}
const rtOf = (d: RuntimeDriver, lockCalls?: { n: number }): DynamicRuntime => ({
  driver: d, envKey: randomBytes(32), health: { intervalMs: 20, timeoutMs: 3000 },
  ...(lockCalls ? { lock: async (_id, fn) => { lockCalls.n++; return fn(); } } : {}),
});

describe('runtime limit versus rollout and rollback', () => {
  it('rolloutDynamic refuses to start for a blocked owner and fails the deployment with the runtime limit message', () => withTestDb(async (db) => {
    const s = await setup(db, true);
    const [nd] = await db.insert(deployments).values({ appId: s.appId, source: 'upload', status: 'processing', sourceKey: 's2', imageRef: 'img:new' }).returning();
    const { d, calls } = driver();
    await rolloutDynamic(db, nd!.id, rtOf(d));
    const [row] = await db.select().from(deployments).where(eq(deployments.id, nd!.id));
    expect(row!.status).toBe('failed');
    expect(row!.message).toBe('deploy.error.runtime_limit');
    expect(calls.starts).toBe(0);
    const [a] = await db.select().from(apps).where(eq(apps.id, s.appId));
    expect(a!.activeDeploymentId).toBe(s.liveId);
  }));

  it('rollback returns runtime_limit (409 in the API) for a blocked owner without starting anything', () => withTestDb(async (db) => {
    const s = await setup(db, true);
    const [old] = await db.insert(deployments).values({ appId: s.appId, source: 'upload', status: 'superseded', sourceKey: 's0', imageRef: 'img:old' }).returning();
    const { d, calls } = driver();
    expect(await rollback(db, s.accountId, s.appId, old!.id, rtOf(d))).toEqual({ error: 'runtime_limit' });
    expect(calls.starts).toBe(0);
  }));

  it('rollback starts the target under the wake lock when the owner is not blocked', () => withTestDb(async (db) => {
    const s = await setup(db, false);
    const [old] = await db.insert(deployments).values({ appId: s.appId, source: 'upload', status: 'superseded', sourceKey: 's0', imageRef: 'img:old' }).returning();
    const { d, calls } = driver();
    const lock = { n: 0 };
    expect(await rollback(db, s.accountId, s.appId, old!.id, rtOf(d, lock))).toEqual({ ok: true });
    expect(calls.starts).toBe(1);
    expect(lock.n).toBe(1);
  }));
});

describe('runtime minutes upkeep', () => {
  it('purges per-minute records older than 400 days and keeps newer ones', () => withTestDb(async (db) => {
    const s = await setup(db, false);
    const now = new Date('2026-10-15T00:00:00Z');
    await db.insert(runtimeMinutes).values([
      { appId: s.appId, minute: new Date(now.getTime() - 401 * 86_400_000), containers: 1 },
      { appId: s.appId, minute: new Date(now.getTime() - 399 * 86_400_000), containers: 1 },
    ]);
    expect(await purgeRuntimeMinutes(db, now)).toBe(1);
    expect(await db.select().from(runtimeMinutes)).toHaveLength(1);
  }));

  it('does not start a metering tick while the previous one is still running', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const driver = { runningCount: async () => { calls++; await gate; return []; }, stop: async () => undefined };
    const stop = startRuntimeMetering({ db: {} as never, driver }, 10);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(1);
    release();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBeGreaterThan(1);
    stop();
  });
});

const rollback = (...a: Parameters<typeof rollbackReal>) => rollbackReal(a[0], a[1], a[2], a[3], a[4], { installed: true, check: async () => 'allow' });
const rolloutDynamic = (...a: Parameters<typeof rolloutDynamicReal>) => rolloutDynamicReal(a[0], a[1], a[2] ? { ...a[2], publication: { installed: true, check: async () => 'allow' } } : undefined);
