import { describe, expect, it } from 'vitest';
import { evaluateMetrics } from '../src/security/detectors.js';
import { DEFAULT_THRESHOLDS as t, validateThresholds } from '../src/security/thresholds.js';
const samples = [0, 30000, 60000].map((at, i) => ({ appId: 'a', at, cpu: 0.9, egressBytes: i * t.egressBytes / 2, connections: i * 500, servedBytes: i * t.servedBytes / 2 }));
describe('injected telemetry', () => {
  it('CPU alone is low; independent egress and served bytes are medium', () => { const result = evaluateMetrics(samples, 60000); expect(result).toHaveLength(4); expect(result[0]).toMatchObject({ source: 'cpu', severity: 'low' }); expect(result.slice(1).every(f => f.severity === 'medium')).toBe(true); });
  it('requires a full window, enough samples, no gaps or reset', () => { expect(evaluateMetrics(samples.slice(1), 60000)).toEqual([]); expect(evaluateMetrics([samples[0]!, samples[2]!], 60000)).toEqual([]); expect(evaluateMetrics(samples.map((s,i) => i === 2 ? { ...s, egressBytes: 0 } : s), 60000)).toEqual([]); expect(evaluateMetrics(samples, 120001)).toEqual([]); });
  it('relaxes only served traffic during boosts', () => { const boosted = evaluateMetrics(samples, 60000, { ...t, servedBytes: t.servedBytes * 2 }); expect(boosted.map(f => f.metric)).toEqual(['cpu', 'egressBytes', 'connections']); });
  it('rejects invalid thresholds and mixed workloads', () => { expect(() => validateThresholds({ ...t, windowMs: -1 })).toThrow(); expect(evaluateMetrics(samples.map((s,i) => i === 1 ? { ...s, appId: 'victim' } : s), 60000)).toEqual([]); });
});

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { withTestDb } from './helpers/db.js';
import { accounts, apps, grants } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { thresholdsFor } from '../src/security/thresholds.js';
it('uses approved grant multiplier only between start/end and stops at revocation', () => withTestDb(async db => {
  const [account] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'fixture', displayName: 'fixture', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, account!.id); await giveStudent(db, account!.id);
  const [app] = await db.insert(apps).values({ ownerId, name: `m-${randomUUID().slice(0,8)}` }).returning();
  const start = new Date('2026-10-24T00:00:00Z'), end = new Date(start.getTime() + 1000);
  const [grant] = await db.insert(grants).values({ kind: 'event_boost', targetKind: 'app', targetId: app!.id, startsAt: start, endsAt: end, params: { anomalyThresholdMultiplier: 3 }, reason: 'fixture', approvedBy: 'fixture' }).returning();
  const at = (n: number) => thresholdsFor(db, ownerId, app!.id, new Date(n));
  expect((await at(+start - 1)).servedBytes).toBe(t.servedBytes);
  expect((await at(+start)).servedBytes).toBe(t.servedBytes * 3);
  expect((await at(+end)).servedBytes).toBe(t.servedBytes * 3);
  expect((await at(+end + 1)).servedBytes).toBe(t.servedBytes);
  await db.update(grants).set({ revokedAt: start }).where(eq(grants.id, grant!.id));
  expect(await at(+start)).toEqual(t);
}));
