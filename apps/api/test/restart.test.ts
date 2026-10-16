import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RuntimeDriver } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createApp } from '../src/apps/apps.js';
import { restart } from '../src/apps/deployments.js';
import { setEnvVar } from '../src/apps/env-vars.js';
import type { DynamicRuntime } from '../src/ingest/dynamic.js';

const envKey = Buffer.alloc(32, 7);
let n = 0;
const srv = createServer((_q, r) => r.end('ok'));
let port = 1;
beforeAll(async () => { await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r)); port = (srv.address() as AddressInfo).port; });
afterAll(() => { srv.close(); });
function fake(healthy: boolean) {
  const calls: string[] = [];
  const env: Record<string, string>[] = [];
  const driver = {
    start: async (spec: { env: Record<string, string> }) => { calls.push('start'); env.push(spec.env); return {}; },
    stopDeployment: async () => { calls.push('stop'); },
    status: async () => (healthy ? 'running' : 'crashed'),
    endpoint: async () => ({ host: '127.0.0.1', port }),
    logs: async () => ['boom'],
  } as unknown as RuntimeDriver;
  const rt: DynamicRuntime = { driver, envKey, health: { timeoutMs: 300, intervalMs: 50 } };
  return { rt, calls, env };
}
async function setup(db: TestDb, kind: 'static' | 'dynamic', active = true) {
  const [a] = await db.insert(accounts).values({ emailHash: `rs${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  const r = await createApp(db, a!.id, { name: `rs-${randomUUID().slice(0, 8)}`, ownerId, kind }) as { appId: string };
  if (active) {
    const [d] = await db.insert(deployments).values({ appId: r.appId, source: 'upload', status: 'live', sourceKey: 'k', imageRef: 'img:1' }).returning();
    await db.update(apps).set({ activeDeploymentId: d!.id }).where(eq(apps.id, r.appId));
  }
  return { accountId: a!.id, appId: r.appId };
}

describe('restart', () => {
  it('stops and starts the active deployment with the current env', () => withTestDb(async (db) => {
    const s = await setup(db, 'dynamic');
    await setEnvVar(db, envKey, s.accountId, s.appId, 'GREETING', 'hi');
    const f = fake(true);
    expect(await restart(db, s.accountId, s.appId, f.rt)).toEqual({ ok: true });
    expect(f.calls).toEqual(['stop', 'start']);
    expect(f.env[0]).toMatchObject({ GREETING: 'hi' });
  }));
  it('rejects static apps, strangers and unhealthy restarts', () => withTestDb(async (db) => {
    const st = await setup(db, 'static', false);
    expect(await restart(db, st.accountId, st.appId, fake(true).rt)).toEqual({ error: 'invalid_state' });
    const s = await setup(db, 'dynamic');
    const other = await setup(db, 'static', false);
    expect(await restart(db, other.accountId, s.appId, fake(true).rt)).toEqual({ error: 'not_found' });
    const r = await restart(db, s.accountId, s.appId, fake(false).rt);
    expect(r).toMatchObject({ error: 'start_failed' });
  }));
});
