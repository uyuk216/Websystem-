import { describe, expect, it } from 'vitest';
import { staticNetworkReputation, withNetworkMode, unconfiguredNetworks } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, studentVerifications, verificationUploads } from '../src/db/schema.js';
import { createApp } from '../src/http/app.js';
import { createSession } from '../src/auth/sessions.js';
import { createNetworkGuard } from '../src/security/network.js';
import { handleSecuritySignal } from '../src/security/incidents.js';
import { buildSignal } from '../src/security/signals.js';
import { hashIp } from '../src/security/ip.js';

const key = Buffer.alloc(32, 9);
const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'a@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com', uploadOrigin: 'https://upload.example.com' };
const year = new Date().getUTCFullYear();
const vbody = JSON.stringify({ schoolName: '東京大学', schoolKind: 'university', expectedGraduationYear: year + 2 });
const hdr = { 'content-type': 'application/json' };
const from = (ip: string) => ({ incoming: { socket: { remoteAddress: ip } } });
const unknownRep = { check: async () => ({ blocked: true as const, reason: 'unknown' as const }) };

async function setup(db: TestDb, network: Parameters<typeof createApp>[0] extends infer D ? (D extends { network?: infer N } ? N : never) : never) {
  const [a] = await db.insert(accounts).values({ emailHash: 'h', emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01' }).returning();
  const s = await createSession(db, a!.id, 'Mac');
  const app = createApp({ db, mailer: createFakeMailer(), config: cfg, network, security: { hashKey: key } } as never);
  return { app, cookie: { cookie: `sid=${s.token}`, ...hdr } };
}
const counts = async (db: TestDb) => ({ acc: (await db.select().from(accounts)).length, up: (await db.select().from(verificationUploads)).length, ver: (await db.select().from(studentVerifications)).length });

describe('entry wiring of the network guard', () => {
  it('signup: known VPN 403, unknown 503, both before any account/session exists; clean IP reaches validation', () => withTestDb(async (db) => {
    const rep = staticNetworkReputation({ '198.51.100.9': 'vpn', '192.0.2.9': 'tor' });
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg, network: rep, security: { hashKey: key } } as never);
    const post = (ip: string) => app.request('/auth/signup', { method: 'POST', headers: hdr, body: '{}' }, from(ip));
    const r1 = await post('198.51.100.9'); expect(r1.status).toBe(403); expect(await r1.json()).toEqual({ error: 'network_blocked' });
    expect((await post('192.0.2.9')).status).toBe(403);
    expect(r1.headers.get('set-cookie') ?? '').not.toContain('sid=');
    expect((await post('198.18.0.1')).status).toBe(400); // passes the guard, rejected as invalid input
    const u = createApp({ db, mailer: createFakeMailer(), config: cfg, network: unknownRep, security: { hashKey: key } } as never);
    const r2 = await u.request('/auth/signup', { method: 'POST', headers: hdr, body: '{}' }, from('198.18.0.1'));
    expect(r2.status).toBe(503); expect(await r2.json()).toEqual({ error: 'network_unavailable' });
    expect(await counts(db)).toMatchObject({ acc: 0 });
  }));

  it('verification start: VPN 403 / unknown 503 create no verification or upload; login-time changes are not stopped', () => withTestDb(async (db) => {
    const vpn = await setup(db, staticNetworkReputation({ '198.51.100.9': 'vpn' }));
    const r = await vpn.app.request('/verification/start', { method: 'POST', headers: vpn.cookie, body: vbody }, from('198.51.100.9'));
    expect(r.status).toBe(403);
    expect(await counts(db)).toMatchObject({ up: 0, ver: 0 });
    // reading status is not a protected action: a VPN user can still view
    expect((await vpn.app.request('/verification/status', { headers: vpn.cookie }, from('198.51.100.9'))).status).toBe(200);
    const unk = createApp({ db, mailer: createFakeMailer(), config: cfg, network: unknownRep, security: { hashKey: key } } as never);
    const cookie = vpn.cookie;
    expect((await unk.request('/verification/start', { method: 'POST', headers: cookie, body: vbody }, from('198.18.0.1'))).status).toBe(503);
    expect((await unk.request('/verification/status', { headers: cookie }, from('198.18.0.1'))).status).toBe(200);
    expect(await counts(db)).toMatchObject({ up: 0, ver: 0 });
  }));

  it('default app (no network injected) is observe: not installed, observed but not blocked', () => withTestDb(async (db) => {
    const { app, cookie } = await setup(db, undefined as never);
    expect((await app.request('/verification/start', { method: 'POST', headers: cookie, body: vbody }, from('198.18.0.1'))).status).toBe(200);
    expect(unconfiguredNetworks.installed).toBe(false);
  }));

  it('guard config: observe by default (not installed), enforce is fail-closed for protected actions, off never checks', async () => {
    const seen: string[] = [];
    const g = createNetworkGuard({});
    expect(g.mode).toBe('observe'); expect(g.status()).toMatchObject({ installed: false, state: 'not_installed', mode: 'observe' });
    expect(await g.reputation.check('198.18.0.1')).toEqual({ blocked: false });
    const e = createNetworkGuard({ SECURITY_NETWORK_MODE: 'enforce' });
    expect(await e.reputation.check('198.18.0.1')).toEqual({ blocked: true, reason: 'unknown' });
    const o = withNetworkMode(unknownRep, 'observe', (ip, v) => { seen.push(`${ip}:${v.blocked}`); });
    await o.check('198.18.0.1'); expect(seen).toEqual(['198.18.0.1:true']);
  });

  it('school/VPN exceptions do not exempt a security block (trap / attack IP stays blocked)', () => withTestDb(async (db) => {
    // The reputation says "school, allowed"; the incident IP block is a separate gate and still applies.
    await handleSecuritySignal(db, buildSignal({ source: 'honeytoken', sourceEventId: 'ev-1', ruleVersion: '1', occurredAt: new Date(), severity: 'high', target: { kind: 'ip', ipHash: hashIp('198.51.100.5', key)! }, reasonCode: 'trap.test', evidence: {} }));
    const app = createApp({ db, mailer: createFakeMailer(), config: cfg, network: staticNetworkReputation({}), security: { hashKey: key } } as never);
    const r = await app.request('/auth/signup', { method: 'POST', headers: hdr, body: '{}' }, from('198.51.100.5'));
    expect(r.status).toBeGreaterThanOrEqual(403);
  }));
});
