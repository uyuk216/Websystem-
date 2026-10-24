import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withTestDb } from './helpers/db.js';
import { accounts, apps, securityBlocks } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createPublicationPolicy, unavailablePublication } from '../src/security/safe-browsing.js';
import { submitReport } from '../src/security/reports.js';
import { FileDistributionDetector, type DistributionStore } from '../src/security/file-distribution.js';
async function fixture(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) { const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'fixture', displayName: 'fixture', locale: 'ja', adultFrom: '2030-01' }).returning(); const ownerId = await ensureAccountOwner(db, a!.id); const [app] = await db.insert(apps).values({ ownerId, name: 'safe-fixture' }).returning(); return { accountId: a!.id, appId: app!.id }; }
describe('publication and reports', () => {
  it('holds unconfigured/timeout; sends only a resolved public origin and records malicious as high', () => withTestDb(async db => { const { appId } = await fixture(db); expect(await unavailablePublication.check(appId)).toBe('pending'); const urls: string[] = []; const policy = createPublicationPolicy(db, { installed: true, check: async url => { urls.push(url); return 'malicious'; } }, 'sites.example.test'); expect(await policy.check(appId)).toBe('malicious'); expect(urls).toEqual(['https://safe-fixture.sites.example.test/']); expect(await db.select().from(securityBlocks)).toHaveLength(1); const timed = createPublicationPolicy(db, { installed: true, check: async () => new Promise(() => {}) }, 'sites.example.test', 1); expect(await timed.check(appId)).toBe('pending'); }));
  it('rate limits durable reports and never blocks on reports or stores message text', () => withTestDb(async db => { const f = await fixture(db); for (let i=0; i<5; i++) expect(await submitReport(db, f.accountId, { appId: f.appId, category: 'abuse', message: 'private message' })).toBe('ok'); expect(await submitReport(db, f.accountId, { appId: f.appId, category: 'abuse' })).toBe('rate_limited'); expect(await db.select().from(securityBlocks)).toHaveLength(0); }));
});
it('requires concentration AND external references; drops query and rotates digests', async () => {
  const rows: Array<{ appId: string; day: string; fileHash: string; bytes: number; external: boolean; at: number }> = [];
  const store: DistributionStore = { append: async row => { rows.push(row); }, window: async (appId, since) => rows.filter(r => r.appId === appId && r.at >= since), prune: async before => { for(let i=rows.length-1;i>=0;i--) if(rows[i]!.at < before) rows.splice(i,1); } };
  const detector = new FileDistributionDetector(Buffer.alloc(32,1), store, { windowMs: 600000, bytes: 100, concentration: 0.8, externalRatio: 0.5, minRequests: 2 });
  const sample = { appId: 'app', path: '/file?secret=one', bytes: 50, origin: 'https://site.example', referrer: 'https://outside.example/path?secret=yes', at: 1000 };
  expect(await detector.record(sample)).toBe(false); expect(await detector.record({ ...sample, path: '/file?secret=two' })).toBe(true); expect(rows[0]!.fileHash).toBe(rows[1]!.fileHash); expect(JSON.stringify(rows)).not.toContain('secret');
  expect(await detector.record({ ...sample, appId: 'missing', referrer: null })).toBe(false); expect(await detector.record({ ...sample, appId: 'missing', referrer: null })).toBe(false);
  await detector.record({ ...sample, at: 86401000 }); expect(rows.at(-1)!.fileHash).not.toBe(rows[0]!.fileHash);
});

import { createDistributionObserver } from '../src/security/file-distribution.js';
it('commits durable evidence and blocking signal together without raw path/referrer', () => withTestDb(async db => {
  const { appId } = await fixture(db);
  const observer = createDistributionObserver(db, Buffer.alloc(32,2), { windowMs: 600000, bytes: 100, concentration: 0.8, externalRatio: 0.5, minRequests: 2 });
  const s = { appId, bytes: 50, path: '/download?secret=private', referrer: 'https://outside.example/private', origin: 'https://safe-fixture.sites.example.test', at: Date.now() };
  await observer.record(s); await observer.record(s);
  expect(await db.select().from(securityBlocks)).toHaveLength(1);
}));
