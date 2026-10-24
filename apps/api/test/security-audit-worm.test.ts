import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AUDIT_S3_COMMANDS, AuditConflictError, FakeWormStorage, disabledAuditStorage, s3AuditStorage, sha256Hex } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, adminAuditLog, auditDeliveries, operators, securityAudit, securityBlocks, securityOutbox } from '../src/db/schema.js';
import { handleSecuritySignal, verifySecurityAudit } from '../src/security/incidents.js';
import { buildSignal } from '../src/security/signals.js';
import { hashIp } from '../src/security/ip.js';
import { adminBatchRow, batchKey, canonicalJson, checkpointKey, systemBatchRow } from '../src/security/audit-export.js';
import { AuditHoldError, setAdminAuditHold, withAdmin } from '../src/admin/audit-log.js';
import {
  alertAuditHealth, auditBacklogHeld, auditDeliveryHandlers, auditDeliveryStatus, deliveredThrough, exportAuditStream, verifyAgainstWorm, withAuditHold,
} from '../src/security/system-audit.js';

const key = Buffer.alloc(32, 9);
const DAY = 86_400_000;
let n = 0;
async function signal(db: TestDb, ip = `203.0.113.${(++n % 250) + 1}`) {
  return handleSecuritySignal(db, buildSignal({ source: 'manual', sourceEventId: `ev-${randomUUID()}`, ruleVersion: '1', occurredAt: new Date(), severity: 'medium', target: { kind: 'ip', ipHash: hashIp(ip, key)! }, reasonCode: 'test.worm', evidence: { note: 'worm test' } }));
}
const clock = (t = Date.now()) => ({ t, now: () => new Date(t) });
const deps = (storage: FakeWormStorage, c = clock()) => ({ storage, retentionMs: 30 * DAY, batchSize: 3, now: c.now });
const allBodies = (s: FakeWormStorage) => Promise.all(s.keysForTest().map(async (k) => new TextDecoder().decode((await s.readVersion(k, (await s.versions(k))[0]!))!))).then((x) => x.join('\n'));
const disableImmutability = (db: TestDb) => db.execute(sql`alter table security_audit disable trigger security_audit_no_update_delete`);

describe('system audit chain and export', () => {
  it('serializes parallel writers into one contiguous chain; rows cannot be edited or deleted', () => withTestDb(async (db) => {
    await Promise.all([signal(db), signal(db), signal(db), signal(db), signal(db)]);
    const rows = await db.select().from(securityAudit).orderBy(securityAudit.seq);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(await verifySecurityAudit(db)).toBeNull();
    await expect(db.execute(sql`update security_audit set action = 'x' where seq = 1`)).rejects.toThrow();
    await expect(db.execute(sql`delete from security_audit where seq = 1`)).rejects.toThrow();
  }));

  it('delivers contiguous batches with versions, retention and checkpoints; the independent check passes; no secrets reach WORM', () => withTestDb(async (db) => {
    for (let i = 0; i < 4; i++) await signal(db); // 8 audit rows
    const worm = new FakeWormStorage(); const d = deps(worm);
    const r = await exportAuditStream(db, 'security', d);
    expect(r).toEqual({ delivered: 3, busy: false }); // 3 + 3 + 2 rows
    expect(await deliveredThrough(db, 'security')).toBe(8);
    const dl = await db.select().from(auditDeliveries).orderBy(auditDeliveries.fromSeq);
    expect(dl.map((x) => [x.fromSeq, x.toSeq])).toEqual([[1, 3], [4, 6], [7, 8]]);
    for (const x of dl) { expect(x.objectVersion).toBeTruthy(); expect(x.checkpointVersion).toBeTruthy(); expect(x.retainUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY); }
    expect(dl[1]!.prevBatchDigest).toBe(dl[0]!.digest);
    expect(worm.keysForTest()).toContain(batchKey('security', 1, 3)); expect(worm.keysForTest()).toContain(checkpointKey('security', 8));
    const v = await verifyAgainstWorm(db, 'security', worm);
    expect(v).toMatchObject({ ok: true, issues: [], checkpointSeq: 8, dbHeadSeq: 8, undelivered: 0 });
    const text = await allBodies(worm);
    expect(text).not.toMatch(/203\.0\.113|@|worm test|:\/\//); // no raw IP, evidence text, e-mail or URL
    expect(text).toContain('test.worm');
    // a later signal is picked up as the next contiguous batch
    await signal(db);
    await exportAuditStream(db, 'security', d);
    expect(await verifyAgainstWorm(db, 'security', worm)).toMatchObject({ ok: true, checkpointSeq: 10 });
  }));

  it('redacts sensitive-looking values instead of copying them; admin export maps the original digest without e-mail/target/detail', () => {
    const row = systemBatchRow({ seq: 1, hash: 'h', prevHash: '', incidentId: randomUUID(), action: 'incident.recorded', createdAt: new Date(), detail: { reasonCode: 'a.b', who: 'user@example.com', ip: '198.51.100.20', url: 'https://x.test/p?token=1', nested: { a: 1 } } as never });
    expect(JSON.stringify(row)).not.toMatch(/user@|198\.51|https?:|token/);
    expect(row.piiFlag).toBe(true); expect(row.reasonCode).toBe('a.b');
    const a = adminBatchRow({ seq: 5, hash: 'h5', prevHash: 'h4', operatorId: randomUUID(), action: 'student.approve', target: 'student:someone@example.com', detail: { note: 'mail someone@example.com' }, createdAt: new Date() });
    expect(JSON.stringify(a)).not.toContain('someone'); expect(a.piiFlag).toBe(true); expect(a.originalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(adminBatchRow({ seq: 6, hash: 'h', prevHash: 'h5', operatorId: randomUUID(), action: 'Bad Action!', target: 'app:xyz', detail: {}, createdAt: new Date() }).action).toBe('redacted');
  });

  it('exports the admin chain without changing it, as a separate contiguous stream', () => withTestDb(async (db) => {
    const [acc] = await db.insert(accounts).values({ emailHash: 'op', emailEnc: 'e', displayName: 'op', locale: 'ja', adultFrom: '2030-01' }).returning();
    await db.insert(operators).values({ accountId: acc!.id, tailscaleLogin: 'op@example.com', role: 'owner' });
    for (const t of ['app:one', 'student:someone@example.com']) await db.insert(adminAuditLog).values({ seq: 0, operatorId: acc!.id, action: 'admin.test', target: t, detail: { note: 'x@example.com' } });
    const before = await db.select().from(adminAuditLog).orderBy(adminAuditLog.seq);
    const worm = new FakeWormStorage();
    await exportAuditStream(db, 'admin', deps(worm));
    expect(await db.select().from(adminAuditLog).orderBy(adminAuditLog.seq)).toEqual(before);
    expect(await verifyAgainstWorm(db, 'admin', worm)).toMatchObject({ ok: true, checkpointSeq: 2 });
    expect(await allBodies(worm)).not.toMatch(/someone|example\.com|op@/);
  }));
});

describe('delivery faults', () => {
  it('rejects a missing retention, never marks delivered, and the immediate defense stays in place', () => withTestDb(async (db) => {
    await signal(db);
    const worm = new FakeWormStorage();
    await expect(exportAuditStream(db, 'security', { ...deps(worm), retentionMs: 0 })).rejects.toThrow('retention_required');
    expect(await deliveredThrough(db, 'security')).toBe(0);
    expect(await db.select().from(securityBlocks)).toHaveLength(1); // block (DB) is unaffected by storage failure
    const [open] = await db.select().from(auditDeliveries);
    expect(open).toMatchObject({ deliveredAt: null, attempts: 1 });
    expect(worm.keysForTest()).toHaveLength(0);
    await expect(exportAuditStream(db, 'security', { storage: disabledAuditStorage, retentionMs: DAY })).rejects.toThrow('not_installed');
  }));

  it('retries after a lost response without a second object or version; a different body at the same key is a conflict, never overwritten', () => withTestDb(async (db) => {
    await signal(db);
    const worm = new FakeWormStorage(); const d = deps(worm);
    worm.loseResponseNext = 1;
    await expect(exportAuditStream(db, 'security', d)).rejects.toThrow('response_lost');
    const [open] = await db.select().from(auditDeliveries); expect(open).toMatchObject({ deliveredAt: null, failureCode: 'response_lost', attempts: 1 });
    await exportAuditStream(db, 'security', d);
    const dl = await db.select().from(auditDeliveries); expect(dl).toHaveLength(1);
    expect(await worm.versions(dl[0]!.objectKey)).toHaveLength(1);
    expect(dl[0]!.attempts).toBe(1); expect(dl[0]!.deliveredAt).not.toBeNull();
    // conflicting pre-existing content at the next batch key
    await signal(db);
    const evil = new TextEncoder().encode('{"evil":true}');
    await worm.append(batchKey('security', 3, 4), evil, sha256Hex(evil), Date.now() + DAY);
    await expect(exportAuditStream(db, 'security', d)).rejects.toBeInstanceOf(AuditConflictError);
    const [bad] = await db.select().from(auditDeliveries).where(eq(auditDeliveries.fromSeq, 3));
    expect(bad).toMatchObject({ deliveredAt: null, failureCode: 'conflict' });
    expect(new TextDecoder().decode((await worm.readVersion(batchKey('security', 3, 4), 'v' + 3))!)).toContain('evil');
  }));

  it('two workers exporting at once never create duplicate or overlapping batches', () => withTestDb(async (db) => {
    for (let i = 0; i < 4; i++) await signal(db);
    const worm = new FakeWormStorage(); const d = deps(worm);
    const rs = await Promise.allSettled([exportAuditStream(db, 'security', d), exportAuditStream(db, 'security', d)]);
    expect(rs.every((r) => r.status === 'fulfilled')).toBe(true);
    await exportAuditStream(db, 'security', d); // finish anything a busy worker skipped
    for (const k of worm.keysForTest()) expect(await worm.versions(k)).toHaveLength(1);
    expect(await verifyAgainstWorm(db, 'security', worm)).toMatchObject({ ok: true, checkpointSeq: 8 });
    const dl = await db.select().from(auditDeliveries).orderBy(auditDeliveries.fromSeq);
    dl.forEach((x, i) => expect(x.fromSeq).toBe(i === 0 ? 1 : dl[i - 1]!.toSeq + 1));
  }));

  it('deliver_audit handler throws (outbox retry) through a storage outage while incidents and blocks stay intact; recovery delivers', () => withTestDb(async (db) => {
    // The handler uses its own connections (worker pool > 1), so it is called directly: the single-connection test DB cannot nest it in drainSecurityOutbox.
    const c = clock(); const worm = new FakeWormStorage(() => c.t);
    await signal(db);
    const handler = auditDeliveryHandlers(db, deps(worm, c)).deliver_audit!;
    const call = () => handler({ seq: 2 }, {} as never, {} as never, new Date(c.t));
    worm.failNext = 100;
    await expect(call()).rejects.toThrow('unavailable');
    expect(await deliveredThrough(db, 'security')).toBe(0);
    expect((await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'deliver_audit'))).every((p) => p.doneAt === null)).toBe(true);
    expect(await db.select().from(securityBlocks)).toHaveLength(1); // immediate defense unaffected
    worm.failNext = 0;
    await call();
    expect(await deliveredThrough(db, 'security')).toBe(2);
    await expect(handler({ seq: 'x' } as never, {} as never, {} as never, new Date())).rejects.toBeInstanceOf(TypeError);
  }));
});

describe('tamper, truncation and rollback detection (Review Focus 5)', () => {
  async function delivered(db: TestDb, signals = 3) {
    for (let i = 0; i < signals; i++) await signal(db);
    const worm = new FakeWormStorage(); await exportAuditStream(db, 'security', deps(worm));
    return worm;
  }
  it('detects an edited row even when the chain is re-computed in DB terms', () => withTestDb(async (db) => {
    const worm = await delivered(db);
    await disableImmutability(db);
    await db.execute(sql`update security_audit set action = 'incident.forged' where seq = 2`);
    const v = await verifyAgainstWorm(db, 'security', worm);
    expect(v.ok).toBe(false); expect(v.issues.join()).toMatch(/db_chain_broken|row_mismatch/);
  }));
  it('detects a missing row (gap)', () => withTestDb(async (db) => {
    const worm = await delivered(db);
    await disableImmutability(db);
    await db.execute(sql`delete from security_audit where seq = 3`);
    const v = await verifyAgainstWorm(db, 'security', worm);
    expect(v.ok).toBe(false); expect(v.issues.join()).toMatch(/db_chain_broken/); expect(v.issues.join()).toMatch(/row_mismatch/);
  }));
  it('detects tail truncation and a restore from an older DB: the DB head is behind the WORM checkpoint, and an in-DB chain check alone still passes', () => withTestDb(async (db) => {
    const worm = await delivered(db);
    await disableImmutability(db);
    await db.execute(sql`delete from security_audit where seq > 3`); // a perfectly valid shorter chain
    expect(await verifySecurityAudit(db)).toBeNull(); // DB-internal verification succeeds
    const v = await verifyAgainstWorm(db, 'security', worm);
    expect(v.ok).toBe(false); expect(v.issues).toContain('db_behind_checkpoint');
  }));
  it('does not call a DB "delivered" without any checkpoint, and reports not installed without a storage', () => withTestDb(async (db) => {
    await signal(db);
    expect((await verifyAgainstWorm(db, 'security', new FakeWormStorage())).issues).toContain('no_checkpoint');
    const v = await verifyAgainstWorm(db, 'security', disabledAuditStorage);
    expect(v.ok).toBe(false); expect(v.issues).toContain('not_installed');
  }));
  it('a new version written to the same key does not replace the original; it is flagged', () => withTestDb(async (db) => {
    const worm = await delivered(db);
    const k = batchKey('security', 1, 3);
    worm.addVersionForTest(k, new TextEncoder().encode(canonicalJson({ forged: true })));
    const v = await verifyAgainstWorm(db, 'security', worm);
    expect(v.issues).toContain(`extra_version:${k}`);
    expect(v.issues.join()).not.toMatch(/row_mismatch|batch_not_canonical/); // the original (oldest) version is what is read
  }));
  it('flags non-COMPLIANCE retention', () => withTestDb(async (db) => {
    const worm = await delivered(db);
    worm.setModeForTest(batchKey('security', 1, 3), 'GOVERNANCE');
    expect((await verifyAgainstWorm(db, 'security', worm)).issues.join()).toMatch(/retention_invalid/);
  }));
});

describe('delivery health, alerts and backlog hold', () => {
  it('reports not installed without alerting; delayed/critical raise operator codes; backlog holds publication and admin changes but not blocks', () => withTestDb(async (db) => {
    for (let i = 0; i < 3; i++) await signal(db);
    const sent: string[][] = []; const alerts = { notify: async (c: string[]) => { sent.push(c); } };
    const off = { storage: disabledAuditStorage };
    expect((await alertAuditHealth(db, 'security', off, alerts)).state).toBe('not_installed'); expect(sent).toEqual([]);
    expect(await auditBacklogHeld(db, off, 1)).toBe(false); // nothing is held while no delivery exists to drain it
    const worm = new FakeWormStorage(); const later = clock(Date.now() + 3_600_000);
    const s = await alertAuditHealth(db, 'security', { storage: worm, now: later.now }, alerts, { delayMs: 60_000, criticalUndelivered: 100 });
    expect(s).toMatchObject({ state: 'delayed', undelivered: 6 }); expect(sent.at(-1)).toEqual(['audit.security.delivery_delayed']);
    const crit = await alertAuditHealth(db, 'security', { storage: worm, now: later.now }, alerts, { delayMs: 60_000, criticalUndelivered: 5 });
    expect(crit.state).toBe('critical'); expect(sent.at(-1)).toContain('audit.security.backlog_critical');
    expect(await auditBacklogHeld(db, { storage: worm }, 5)).toBe(true);
    const held = withAuditHold({ installed: true, check: async () => 'allow' }, () => auditBacklogHeld(db, { storage: worm }, 5));
    expect(await held.check('any')).toBe('pending'); // new publication / rollback held, old versions stay live
    setAdminAuditHold(() => auditBacklogHeld(db, { storage: worm }, 5));
    try { await expect(withAdmin(db, { accountId: randomUUID() }, { action: 'x', target: 'y' }, async () => 1)).rejects.toBeInstanceOf(AuditHoldError); }
    finally { setAdminAuditHold(null); }
    expect(await db.select().from(securityBlocks)).toHaveLength(3); // existing blocks remain
    await exportAuditStream(db, 'security', deps(worm));
    expect(await auditBacklogHeld(db, { storage: worm }, 5)).toBe(false);
    expect((await auditDeliveryStatus(db, 'security', { storage: worm })).state).toBe('ok');
  }));
});

describe('S3 adapter contract (stub client only; nothing is contacted)', () => {
  it('uses only allow-listed commands, always sets COMPLIANCE lock + conditional write, and has no delete / shorten surface', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const client = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => { sent.push({ name: c.constructor.name, input: c.input }); return { VersionId: 'ver-1', Versions: [], IsTruncated: false }; } };
    const s = s3AuditStorage(client, 'audit-bucket-placeholder');
    const body = new TextEncoder().encode('{}');
    expect(await s.append('k', body, sha256Hex(body), Date.now() + DAY)).toMatchObject({ versionId: 'ver-1', mode: 'COMPLIANCE' });
    await s.versions('k'); await s.list('p/');
    expect(sent.every((x) => (AUDIT_S3_COMMANDS as readonly string[]).includes(x.name))).toBe(true);
    expect(sent[0]!.input).toMatchObject({ ObjectLockMode: 'COMPLIANCE', IfNoneMatch: '*', Bucket: 'audit-bucket-placeholder' });
    expect(AUDIT_S3_COMMANDS.join()).not.toMatch(/Delete|Retention$|Bucket|Bypass/);
    expect(Object.keys(s).some((k) => /delete|remove|shorten|bypass/i.test(k))).toBe(false);
    expect(Object.keys(new FakeWormStorage()).concat(Object.getOwnPropertyNames(FakeWormStorage.prototype)).some((k) => /^(delete|remove)/i.test(k))).toBe(false);
    await expect(s.append('k', body, 'bad', Date.now() + DAY)).rejects.toThrow('digest_mismatch');
    await expect(s.append('k', body, sha256Hex(body), Date.now() - 1)).rejects.toThrow('retention_required');
  });
});
