import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { HONEYTOKEN_KINDS, HoneytokenRegistry, PLACEMENT_TEMPLATES, decoyDotenvBody, detectDecoyReads, disabledDbAudit, generateHoneytokenValue, syntheticStudent, type HoneytokenKind } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { createApp } from '../src/http/app.js';
import { securityAudit, securityBlocks, securityIncidents, securityOutbox } from '../src/db/schema.js';
import { ScanDetector, isScanPath } from '../src/security/scan-detector.js';
import { honeytokenStatus } from '../src/security/decoys.js';
import { hashIp } from '../src/security/ip.js';

const key = Buffer.alloc(32, 9);
const cfg = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'a@example.com', appOrigin: 'https://app.example.com', rpId: 'app.example.com' };
const HOST = 'app.example.com';
const hdr = { host: HOST, 'content-type': 'application/json' };
const from = (ip?: string) => (ip ? { incoming: { socket: { remoteAddress: ip } } } : undefined);
let n = 0;
const rand = (len: number) => Buffer.alloc(len, ++n);
const values = Object.fromEntries(HONEYTOKEN_KINDS.map((k) => [k, generateHoneytokenValue(k, rand)])) as Record<HoneytokenKind, string>;

function registry(now = Date.now()) {
  const reg = new HoneytokenRegistry(Buffer.alloc(32, 4), () => now);
  for (const kind of HONEYTOKEN_KINDS) {
    reg.register({ kind, placementId: `trap-${kind.replace(/_/g, '-')}-01`, detections: PLACEMENT_TEMPLATES[kind].detections, validFrom: now - 1000, validUntil: now + 86_400_000, relation: kind.startsWith('decoy_') && kind.endsWith('row') ? `decoy_${kind}` : undefined }, values[kind]);
  }
  return reg;
}
const build = (db: TestDb, extra: Record<string, unknown> = {}) => createApp({
  db, mailer: createFakeMailer(), config: cfg, security: { hashKey: key },
  decoys: { registry: registry(), publicHosts: [HOST], dotenvValue: values.decoy_dotenv, scan: new ScanDetector({ threshold: 3 }) }, ...extra,
} as never);
const dump = async (db: TestDb) => JSON.stringify([await db.select().from(securityIncidents), await db.select().from(securityAudit), await db.select().from(securityOutbox), await db.select().from(securityBlocks)]);

describe('honeytoken placements (all 7 kinds)', () => {
  it('defines a placement and a detection path for each of the 7 kinds; the registry reports coverage', () => {
    expect(HONEYTOKEN_KINDS).toHaveLength(7);
    for (const k of HONEYTOKEN_KINDS) expect(PLACEMENT_TEMPLATES[k].detections.length).toBeGreaterThan(0);
    const reg = registry();
    expect(reg.coverage().every((c) => c.placed)).toBe(true);
    expect(honeytokenStatus(reg)).toEqual({ installed: true, placed: 7, missing: [] });
    const empty = new HoneytokenRegistry(Buffer.alloc(32, 4));
    expect(honeytokenStatus(empty)).toMatchObject({ installed: false, placed: 0 }); // not installed until a deploy registers placements
    expect(reg.lookup(values.fake_env_key)?.kind).toBe('fake_env_key');
    expect(reg.lookup('not-a-trap')).toBeNull();
    expect(reg.lookup('x'.repeat(5000))).toBeNull();
  });
  it('ignores expired placements, and decoy content carries no real data or credentials', () => {
    const t = Date.now(); const reg = new HoneytokenRegistry(Buffer.alloc(32, 4), () => t + 10_000);
    reg.register({ kind: 'fake_env_key', placementId: 'trap-expired-01', detections: ['fake_auth'], validFrom: t - 5000, validUntil: t + 5000 }, 'ht_old');
    expect(reg.lookup('ht_old')).toBeNull();
    expect(decoyDotenvBody(values.decoy_dotenv)).toBe(`# generated\nSERVICE_API_KEY=${values.decoy_dotenv}\n`);
    const s = syntheticStudent('trap-student-01');
    expect(s.email.endsWith('.invalid')).toBe(true);
    expect(s.birthDate).toBe('1900-01-01');
    expect(() => reg.register({ kind: 'fake_env_key', placementId: 'BAD ID', detections: [], validFrom: 1, validUntil: 2 })).toThrow();
  });
});

describe('decoy routes', () => {
  it('serves /.env only on the public host with the fake key, no-store; tenant hosts and unconfigured get 404', () => withTestDb(async (db) => {
    const app = build(db);
    const r = await app.request('/.env', { headers: { host: HOST } }, from('198.51.100.1'));
    expect(r.status).toBe(200); expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toBe(decoyDotenvBody(values.decoy_dotenv));
    expect((await app.request('/.env', { headers: { host: 'victim.sites.example.com' } }, from('198.51.100.1'))).status).toBe(404);
    expect((await app.request('/admin/login', { headers: { host: 'victim.sites.example.com' } }, from('198.51.100.1'))).status).toBe(404);
    const noValue = createApp({ db, mailer: createFakeMailer(), config: cfg, security: { hashKey: key }, decoys: { registry: registry(), publicHosts: [HOST] } } as never);
    expect((await noValue.request('/.env', { headers: { host: HOST } }, from('198.51.100.1'))).status).toBe(404);
    expect(await db.select().from(securityIncidents)).toHaveLength(0); // reading /.env alone is not trap use
  }));

  it('fake credential use fires: high, only that IP is blocked, urgent operator notice once, identical response, no key value stored', () => withTestDb(async (db) => {
    const app = build(db);
    const use = (token: string | undefined, ip = '198.51.100.7') => app.request('/decoy/auth', { method: 'POST', headers: token ? { ...hdr, authorization: `Bearer ${token}` } : hdr }, from(ip));
    const miss = await use('ht_not_registered'); const missBody = await miss.text();
    expect(await db.select().from(securityIncidents)).toHaveLength(0);
    const hit = await use(values.fake_env_key);
    expect(hit.status).toBe(miss.status); expect(await hit.text()).toBe(missBody);
    const [inc] = await db.select().from(securityIncidents);
    expect(inc).toMatchObject({ source: 'honeytoken', severity: 'high', targetKind: 'ip', reasonCode: 'trap.fake_env_key', ipHash: hashIp('198.51.100.7', key) });
    const blocks = await db.select().from(securityBlocks); expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ targetKind: 'ip', appId: null, accountId: null });
    const out = await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'notify_operator'));
    expect(out).toHaveLength(1); expect(out[0]!.priority).toBe(100);
    // the same IP reusing the key (or another key from the same placement) stays one incident / one urgent notice
    await use(values.fake_env_key);
    expect(await db.select().from(securityIncidents)).toHaveLength(1);
    expect(await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'notify_operator'))).toHaveLength(1);
    // the blocked IP is now stopped everywhere; another IP is not
    expect((await app.request('/healthz', { headers: hdr }, from('198.51.100.7'))).status).toBe(200);
    const blocked = await app.request('/plan', { headers: hdr }, from('198.51.100.7'));
    expect(blocked.status).toBe(403);
    expect((await app.request('/plan', { headers: hdr }, from('198.51.100.8'))).status).not.toBe(403);
    expect(await dump(db)).not.toContain(values.fake_env_key);
    // every credential-style kind (④ fake repo key included) fires through the same fake auth port
    await use(values.fake_repo_key, '198.51.100.9');
    expect((await db.select().from(securityIncidents).where(eq(securityIncidents.reasonCode, 'trap.fake_repo_key'))).length).toBe(1);
  }));

  it('fake internal URL fires only for the registered decoy id; ordinary 404s do not', () => withTestDb(async (db) => {
    const app = build(db);
    expect((await app.request('/_int/some-other-id', { headers: hdr }, from('198.51.100.2'))).status).toBe(404);
    expect((await app.request('/_int/trap-fake-env-key-01', { headers: hdr }, from('198.51.100.2'))).status).toBe(404); // wrong kind
    expect(await db.select().from(securityIncidents)).toHaveLength(0);
    expect((await app.request('/_int/trap-decoy-internal-url-01', { headers: hdr }, from('198.51.100.2'))).status).toBe(403);
    expect(await db.select().from(securityIncidents)).toMatchObject([{ reasonCode: 'trap.decoy_internal_url', severity: 'high' }]);
  }));

  it('fake /admin/login: GET and empty POST do not fire; a POST with input fires and the body is never stored', () => withTestDb(async (db) => {
    const app = build(db);
    const get = await app.request('/admin/login', { headers: { host: HOST } }, from('198.51.100.3'));
    expect(get.status).toBe(200); expect(get.headers.get('cache-control')).toBe('no-store');
    expect(await get.text()).not.toMatch(/<script/i);
    expect((await app.request('/admin/login', { method: 'POST', headers: hdr, body: '' }, from('198.51.100.3'))).status).toBe(401);
    expect(await db.select().from(securityIncidents)).toHaveLength(0);
    const post = await app.request('/admin/login', { method: 'POST', headers: hdr, body: 'u=root&p=Sup3rSecret-Pass' }, from('198.51.100.3'));
    expect(post.status).toBe(401);
    expect(await db.select().from(securityIncidents)).toMatchObject([{ reasonCode: 'trap.decoy_admin_login', severity: 'high' }]);
    const all = await dump(db);
    expect(all).not.toContain('Sup3rSecret'); expect(all).not.toContain('u=root');
    expect((await app.request('/admin/login', { method: 'POST', headers: hdr, body: 'x'.repeat(5000) }, from('198.51.100.4'))).status).toBe(413);
  }));

  it('unattributable IP (no trusted address) records a low operator notice and blocks nobody (shared "unknown" is never blocked)', () => withTestDb(async (db) => {
    const app = build(db);
    await app.request('/decoy/auth', { method: 'POST', headers: { ...hdr, authorization: `Bearer ${values.fake_env_key}` } }); // no socket
    const [inc] = await db.select().from(securityIncidents);
    expect(inc).toMatchObject({ severity: 'low', reasonCode: 'trap.fake_env_key' });
    expect(await db.select().from(securityBlocks)).toHaveLength(0);
    expect((await app.request('/plan', { headers: hdr })).status).not.toBe(403);
  }));

  it('scan probes are aggregated per source: only the scanning IP is blocked, never an app or other visitors', () => withTestDb(async (db) => {
    const app = build(db);
    const probe = (p: string, ip?: string) => app.request(p, { headers: hdr }, from(ip));
    await probe('/.git/config', '203.0.113.50'); await probe('/wp-admin', '203.0.113.50');
    expect(await db.select().from(securityIncidents)).toHaveLength(0); // below threshold
    await probe('/.git/config', '203.0.113.50'); // same path again: not distinct
    expect(await db.select().from(securityIncidents)).toHaveLength(0);
    await probe('/phpmyadmin/', '203.0.113.50');
    const [inc] = await db.select().from(securityIncidents);
    expect(inc).toMatchObject({ reasonCode: 'scan.probe', severity: 'medium', targetKind: 'ip', ipHash: hashIp('203.0.113.50', key) });
    const blocks = await db.select().from(securityBlocks); expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ targetKind: 'ip', appId: null });
    expect((await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'notify_operator')))[0]!.priority).toBe(0); // scans do not flood the urgent trap queue
    expect((await probe('/plan', '203.0.113.51')).status).not.toBe(403);
    // sources without a trusted address are never aggregated into a shared "unknown" block
    for (const p of ['/.git/config', '/wp-admin', '/phpmyadmin', '/.aws/credentials', '/xmlrpc.php']) await probe(p);
    expect(await db.select().from(securityBlocks)).toHaveLength(1);
    // a probe on a tenant (non-public) host is not counted
    await app.request('/wp-admin', { headers: { host: 'victim.sites.example.com' } }, from('203.0.113.60'));
  }));

  it('does not touch the real app routes or mount any admin API on the public app', () => withTestDb(async (db) => {
    const app = build(db);
    expect((await app.request('/healthz', { headers: hdr }, from('198.51.100.5'))).status).toBe(200);
    expect((await app.request('/admin/operators', { headers: hdr }, from('198.51.100.5'))).status).toBe(404);
    expect(isScanPath('/.git/config')).toBe(true); expect(isScanPath('/plan')).toBe(false); expect(isScanPath('/%2e%67it/config')).toBe(true); // encoded form is decoded first
  }));
});

describe('scan detector bounds', () => {
  it('fires once per window, resets on the next window, and keeps state bounded', () => {
    let t = 0; const d = new ScanDetector({ threshold: 2, windowMs: 1000, maxSources: 3, now: () => t });
    expect(d.record('a', '/.git').fire).toBe(false); expect(d.record('a', '/wp-admin').fire).toBe(true); expect(d.record('a', '/phpmyadmin').fire).toBe(false);
    t = 1500; expect(d.record('a', '/.git').fire).toBe(false); expect(d.record('a', '/wp-admin').fire).toBe(true);
    for (const s of ['b', 'c', 'd', 'e']) d.record(s, '/.git'); // eviction keeps it from growing without bound
    expect((d as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(3);
  });
});

describe('DB audit fixtures for decoy relations (②③)', () => {
  const decoys = [{ relation: 'public.decoy_admins', placementId: 'trap-decoy-admin-row-01' }, { relation: 'pii.decoy_students', placementId: 'trap-decoy-student-row-01' }];
  const line = (rel: string, cls = 'READ', user = 'app_rw') => ({ at: 1000, line: `2030-01-01 00:00:00 UTC user=${user} LOG:  AUDIT: SESSION,1,1,${cls},SELECT,TABLE,${rel},"select * from secret_stmt",<not logged>` });
  it('detects reads of the decoy relations only; ordinary relations, unknown roles allowed lists and non-audit lines do not fire', () => {
    const lines = [line('public.accounts'), line('public.decoy_admins'), line('pii.decoy_students', 'WRITE'), line('pii.decoy_students', 'READ', 'backup_role'), line('public.apps'), { at: 5, line: 'LOG: connection received' }, line('public.decoy_admins', 'DDL')];
    expect(detectDecoyReads(lines, decoys, { allowedRoles: ['backup_role'] })).toEqual([
      { placementId: 'trap-decoy-admin-row-01', at: 1000 }, { placementId: 'trap-decoy-student-row-01', at: 1000 },
    ]);
    expect(detectDecoyReads([line('public.accounts'), line('public.apps')], decoys)).toEqual([]); // normal DB use never fires
    expect(JSON.stringify(detectDecoyReads(lines, decoys))).not.toContain('secret_stmt');
  });
  it('is disabled (not installed) without the audit extension and collector', async () => {
    expect(disabledDbAudit.installed).toBe(false); expect(await disabledDbAudit.read()).toEqual([]);
  });
});
