import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SecuritySignal, Severity } from 'shared';
import { withTestDb, type TestDb } from './helpers/db.js';
import * as schema from '../src/db/schema.js';
import { accounts, apps, securityAudit, securityBlocks, securityIncidents, securityOutbox } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { withAccount } from '../src/db/client.js';
import { buildSignal, SignalRejected } from '../src/security/signals.js';
import { activeBlocks, handleSecuritySignal, verifySecurityAudit } from '../src/security/incidents.js';
import { drainSecurityOutbox, stopAppHandlers } from '../src/security/actions.js';
import { backoffMs } from '../src/security/outbox.js';

let n = 0;
async function acct(db: TestDb) {
  const email = `s${n++}-${randomUUID().slice(0, 6)}@example.com`;
  const [a] = await db.insert(accounts).values({ emailHash: email, emailEnc: 'x', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  return { id: a!.id, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function app(db: TestDb, ownerId: string) {
  const [r] = await db.insert(apps).values({ ownerId, name: `a-${randomUUID().slice(0, 8)}`, kind: 'dynamic' }).returning();
  return r!.id;
}
const T0 = new Date('2026-10-24T00:00:00Z');
function sig(target: SecuritySignal['target'], severity: Severity, over: Partial<Omit<SecuritySignal, 'evidenceDigest'>> = {}) {
  return buildSignal({ source: 'falco', sourceEventId: `e-${randomUUID().slice(0, 8)}`, ruleVersion: '1', occurredAt: T0, severity, target, reasonCode: 'falco.shell', evidence: { rule: 'terminal_shell', count: 1 }, ...over });
}
async function denied(p: Promise<unknown>): Promise<void> {
  const e = await p.then(() => null, (x: unknown) => x as { message: string; cause?: { message?: string } });
  expect(e, 'expected permission denied').not.toBeNull();
  expect(`${e!.cause?.message ?? ''} ${e!.message}`).toMatch(/permission denied/);
}
const counts = async (db: TestDb) => ({
  incidents: (await db.select().from(securityIncidents)).length, blocks: (await db.select().from(securityBlocks)).length,
  outbox: (await db.select().from(securityOutbox)).length, audit: (await db.select().from(securityAudit)).length,
});
async function pool(db: TestDb, max = 4) {
  const r = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const u = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
  u.pathname = `/${r[0]!.name}`;
  const client = postgres(u.toString(), { max, onnotice: () => {} });
  return { db: drizzle(client, { schema }) as never as TestDb, end: () => client.end() };
}

describe('handleSecuritySignal: 重大度ごとの対処', () => {
  it('高 = アプリ遮断 + コンテナ停止 + 運営通知。停止は outbox から実行され、遮断は事件の commit 時点で有効', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    const r = await handleSecuritySignal(db, sig({ kind: 'app', appId: id, ownerId: a.ownerId }, 'high'), { now: T0 });
    expect(r).toMatchObject({ duplicate: false, escalated: false, severity: 'high', blockCreated: true });
    expect(await activeBlocks(db, { appId: id })).toHaveLength(1);
    const kinds = (await db.select().from(securityOutbox)).map((o) => o.kind).sort();
    expect(kinds).toEqual(['deliver_audit', 'deliver_audit', 'notify_operator', 'stop_app']);
    expect(await verifySecurityAudit(db)).toBeNull();
  }));

  it('中 = アプリ遮断のみ（停止しない）、低 = 運営通知のみ（遮断しない）', () => withTestDb(async (db) => {
    const a = await acct(db); const m = await app(db, a.ownerId); const l = await app(db, a.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: m }, 'medium'));
    await handleSecuritySignal(db, sig({ kind: 'app', appId: l }, 'low'));
    expect(await activeBlocks(db, { appId: m })).toHaveLength(1);
    expect(await activeBlocks(db, { appId: l })).toHaveLength(0);
    const o = await db.select().from(securityOutbox);
    expect(o.filter((x) => x.kind === 'stop_app')).toHaveLength(0);
    expect(o.filter((x) => x.kind === 'notify_operator')).toHaveLength(2);
  }));

  it('停止の副作用は drain で実行。失敗しても遮断は残り、間隔を空けて再試行して成功する', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: id }, 'high'), { now: T0 });
    let fail = true; const stopped: string[] = [];
    const handlers = stopAppHandlers({ stop: async (x) => { if (fail) throw new Error('docker down: secret'); stopped.push(x); } });
    expect(await drainSecurityOutbox(db, handlers, { now: T0 })).toEqual({ done: 0, failed: 1 });
    expect(await activeBlocks(db, { appId: id })).toHaveLength(1);
    const [row] = await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'stop_app'));
    expect(row).toMatchObject({ attempts: 1, failureCode: 'Error', doneAt: null });
    expect(row!.nextAttemptAt.getTime()).toBe(T0.getTime() + backoffMs(1));
    expect(await drainSecurityOutbox(db, handlers, { now: new Date(T0.getTime() + 1000) })).toEqual({ done: 0, failed: 0 }); // まだ待つ
    fail = false;
    expect(await drainSecurityOutbox(db, handlers, { now: new Date(T0.getTime() + 60_000) })).toEqual({ done: 1, failed: 0 });
    expect(stopped).toEqual([id]);
    // 通知の handler は無いので触らず残る
    expect((await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'notify_operator')))[0]!.doneAt).toBeNull();
  }));
});

describe('handleSecuritySignal: 対象の分離と偽装', () => {
  it('app / account / ip のブロックは互いに効かず、同じオーナーの別アプリも止めない', () => withTestDb(async (db) => {
    const a = await acct(db); const one = await app(db, a.ownerId); const two = await app(db, a.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: one }, 'high'));
    expect(await activeBlocks(db, { appId: two })).toHaveLength(0);
    expect(await activeBlocks(db, { accountId: a.id })).toHaveLength(0);
    const ip = 'a'.repeat(64);
    await handleSecuritySignal(db, sig({ kind: 'ip', ipHash: ip }, 'medium', { source: 'honeytoken', reasonCode: 'honey.scan' }));
    expect(await activeBlocks(db, { ipHash: ip })).toHaveLength(1);
    expect(await activeBlocks(db, { appId: two, accountId: a.id })).toHaveLength(0);
    await handleSecuritySignal(db, sig({ kind: 'account', accountId: a.id }, 'high', { reasonCode: 'abuse.account' }));
    expect(await activeBlocks(db, { accountId: a.id })).toHaveLength(1);
    expect(await activeBlocks(db, { appId: two })).toHaveLength(0);
    // 高でも ip / account にはコンテナ停止を積まない（停止はアプリ対象だけ）
    expect((await db.select().from(securityOutbox).where(eq(securityOutbox.kind, 'stop_app')))).toHaveLength(1);
  }));

  it('実在しないアプリ・オーナーの違う主張・不正な形は拒否し、何も書かない', () => withTestDb(async (db) => {
    const a = await acct(db); const b = await acct(db); const id = await app(db, a.ownerId);
    await expect(handleSecuritySignal(db, sig({ kind: 'app', appId: randomUUID() }, 'high'))).rejects.toMatchObject({ code: 'untrusted_target' });
    await expect(handleSecuritySignal(db, sig({ kind: 'app', appId: id, ownerId: b.ownerId }, 'high'))).rejects.toBeInstanceOf(SignalRejected);
    await expect(handleSecuritySignal(db, sig({ kind: 'account', accountId: randomUUID() }, 'high'))).rejects.toMatchObject({ code: 'untrusted_target' });
    await expect(handleSecuritySignal(db, sig({ kind: 'ip', ipHash: '1.2.3.4' }, 'high'))).rejects.toMatchObject({ code: 'bad_target' });
    expect(await counts(db)).toEqual({ incidents: 0, blocks: 0, outbox: 0, audit: 0 });
  }));

  it('証拠は許可リストのキーだけ。生の IP・クエリ付き URL・未知のキー・ダイジェスト不一致は拒否', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId); const target = { kind: 'app', appId: id } as const;
    const bad: Array<Record<string, string | number | boolean>> = [{ password: 'x' }, { note: 'from 203.0.113.9' }, { note: 'https://x.test/?token=1' }, { note: 'fe80::1:2:3' }, { note: 'a'.repeat(200) }];
    for (const evidence of bad) {
      await expect(handleSecuritySignal(db, sig(target, 'high', { evidence }))).rejects.toBeInstanceOf(SignalRejected);
    }
    await expect(handleSecuritySignal(db, { ...sig(target, 'high'), evidenceDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'digest_mismatch' });
    expect(await counts(db)).toEqual({ incidents: 0, blocks: 0, outbox: 0, audit: 0 });
  }));
});

describe('handleSecuritySignal: 重複・昇格・同時実行', () => {
  it('rejects a reused event id that changes the trusted target or reason', () => withTestDb(async (db) => {
    const a = await acct(db); const one = await app(db, a.ownerId); const two = await app(db, a.ownerId);
    const event = { sourceEventId: 'same-event' };
    await handleSecuritySignal(db, sig({ kind: 'app', appId: one }, 'low', event));
    const before = await counts(db);
    await expect(handleSecuritySignal(db, sig({ kind: 'app', appId: two }, 'high', event))).rejects.toMatchObject({ code: 'untrusted_target' });
    await expect(handleSecuritySignal(db, sig({ kind: 'app', appId: one }, 'high', { ...event, reasonCode: 'other.rule' }))).rejects.toMatchObject({ code: 'untrusted_target' });
    expect(await counts(db)).toEqual(before);
  }));

  it('同じ (source, sourceEventId) の再配送は何も増やさない', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    const s = sig({ kind: 'app', appId: id }, 'high');
    await handleSecuritySignal(db, s);
    const before = await counts(db);
    expect(await handleSecuritySignal(db, s)).toMatchObject({ duplicate: true, blockCreated: false });
    expect(await counts(db)).toEqual(before);
  }));

  it('低 → 中 → 高で対処が強まり、後から低が来ても弱まらない（既存のブロックは外れない）', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId); const target = { kind: 'app', appId: id } as const;
    const ev = { sourceEventId: 'evt-1' };
    await handleSecuritySignal(db, sig(target, 'low', ev));
    expect(await activeBlocks(db, { appId: id })).toHaveLength(0);
    expect(await handleSecuritySignal(db, sig(target, 'medium', ev))).toMatchObject({ escalated: true, severity: 'medium', blockCreated: true });
    expect((await db.select().from(securityOutbox)).filter((o) => o.kind === 'stop_app')).toHaveLength(0);
    expect(await handleSecuritySignal(db, sig(target, 'high', ev))).toMatchObject({ escalated: true, severity: 'high', blockCreated: false });
    expect((await db.select().from(securityOutbox)).filter((o) => o.kind === 'stop_app')).toHaveLength(1);
    expect(await handleSecuritySignal(db, sig(target, 'low', ev))).toMatchObject({ duplicate: true, severity: 'high' });
    await handleSecuritySignal(db, sig(target, 'low')); // 別の低い事件
    expect(await activeBlocks(db, { appId: id })).toHaveLength(1);
    expect((await db.select().from(securityIncidents).where(eq(securityIncidents.sourceEventId, 'evt-1')))[0]!.severity).toBe('high');
    expect(await verifySecurityAudit(db)).toBeNull();
  }));

  it('同じ理由のブロックは重複せず、別の理由は別の行（解除は理由ごとにできる）', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId); const target = { kind: 'app', appId: id } as const;
    await handleSecuritySignal(db, sig(target, 'medium'));
    await handleSecuritySignal(db, sig(target, 'high'));
    expect(await activeBlocks(db, { appId: id })).toHaveLength(1);
    await handleSecuritySignal(db, sig(target, 'medium', { reasonCode: 'cpu.spike' }));
    expect((await activeBlocks(db, { appId: id })).map((b) => b.reasonCode).sort()).toEqual(['cpu.spike', 'falco.shell']);
  }));

  it('別接続からの同時の昇格・重複でも、事件 1 件・ブロック 1 件・停止 1 件に収まる', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId); const target = { kind: 'app', appId: id } as const;
    const p = await pool(db, 6);
    try {
      const ev = { sourceEventId: 'race-1' };
      const runs = await Promise.all([
        handleSecuritySignal(p.db as never, sig(target, 'low', ev)), handleSecuritySignal(p.db as never, sig(target, 'high', ev)),
        handleSecuritySignal(p.db as never, sig(target, 'medium', ev)), handleSecuritySignal(p.db as never, sig(target, 'high', ev)),
      ]);
      expect(runs.every((r) => r.incidentId === runs[0]!.incidentId)).toBe(true);
    } finally { await p.end(); }
    const c = await counts(db);
    expect(c.incidents).toBe(1); expect(c.blocks).toBe(1);
    expect((await db.select().from(securityIncidents))[0]!.severity).toBe('high');
    expect((await db.select().from(securityOutbox)).filter((o) => o.kind === 'stop_app')).toHaveLength(1);
    expect(await verifySecurityAudit(db)).toBeNull();
  }));

  it('システム監査の追記が失敗したら、事件・ブロック・outbox も残らない（rollback）', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    await db.execute(sql`create function sec_test_fail() returns trigger language plpgsql as $$ begin raise exception 'audit down'; end $$`);
    await db.execute(sql`create trigger aaa_fail before insert on security_audit for each row execute function sec_test_fail()`);
    await expect(handleSecuritySignal(db, sig({ kind: 'app', appId: id }, 'high'))).rejects.toThrow();
    expect(await counts(db)).toEqual({ incidents: 0, blocks: 0, outbox: 0, audit: 0 });
  }));
});

describe('システム用監査連鎖と RLS', () => {
  it('追記専用で、改ざんは verify が最初の seq を返す', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: id }, 'high'));
    await handleSecuritySignal(db, sig({ kind: 'app', appId: id }, 'medium', { reasonCode: 'cpu.spike' }));
    const rows = await db.select().from(securityAudit).orderBy(securityAudit.seq);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(JSON.stringify(rows.map((r) => r.detail))).not.toContain(id); // アカウント / アプリとの対応は監査に出さない
    await expect(db.update(securityAudit).set({ action: 'x' }).where(eq(securityAudit.seq, 1))).rejects.toThrow();
    await expect(db.delete(securityAudit)).rejects.toThrow();
    await db.execute(sql`alter table security_audit disable trigger security_audit_no_update_delete`);
    await db.update(securityAudit).set({ action: 'tampered' }).where(eq(securityAudit.seq, 2));
    expect(await verifySecurityAudit(db)).toBe(2);
    await db.delete(securityAudit).where(eq(securityAudit.seq, 3)); // 末尾の切り捨ては seq 2 の改ざんより後でも…
    expect(await verifySecurityAudit(db)).toBe(2);
  }));

  it('利用者は自分のアプリの事件の要約だけ読める。証拠・ブロック・outbox・監査・他人の事件は読めない', () => withTestDb(async (db) => {
    const a = await acct(db); const b = await acct(db);
    const mine = await app(db, a.ownerId); const theirs = await app(db, b.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: mine }, 'high'));
    await handleSecuritySignal(db, sig({ kind: 'app', appId: theirs }, 'high'));
    await handleSecuritySignal(db, sig({ kind: 'account', accountId: b.id }, 'medium', { reasonCode: 'abuse.account' }));
    await withAccount(db, a.id, async (tx) => {
      const rows = await tx.select({ id: securityIncidents.id, appId: securityIncidents.appId, severity: securityIncidents.severity }).from(securityIncidents);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.appId).toBe(mine);
    });
    for (const q of [sql`select evidence from security_incidents`, sql`select * from security_incidents`, sql`select * from security_blocks`, sql`select * from security_outbox`, sql`select * from security_audit`]) {
      await denied(withAccount(db, a.id, (tx) => tx.execute(q)));
    }
    await expect(withAccount(db, a.id, (tx) => tx.insert(securityIncidents).values({
      source: 'falco', sourceEventId: 'x', ruleVersion: '1', severity: 'low', targetKind: 'app', appId: mine, reasonCode: 'x', evidenceDigest: 'x', occurredAt: T0 }))).rejects.toThrow();
    // 認証なし（account id 未設定）は 0 行
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role platform_api`);
      expect(await tx.execute(sql`select id from security_incidents`)).toHaveLength(0);
    });
  }));

  it('運営側（platform_admin）は読めるが書けない', () => withTestDb(async (db) => {
    const a = await acct(db); const id = await app(db, a.ownerId);
    await handleSecuritySignal(db, sig({ kind: 'app', appId: id }, 'high'));
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local role platform_admin`);
      expect(await tx.execute(sql`select id from security_incidents`)).toHaveLength(1);
      expect(await tx.execute(sql`select id from security_blocks`)).toHaveLength(1);
      expect(await tx.execute(sql`select security_audit_verify() as bad`)).toMatchObject([{ bad: null }]);
    });
    await denied(db.transaction(async (tx) => {
      await tx.execute(sql`set local role platform_admin`);
      await tx.execute(sql`update security_blocks set released_at = now()`);
    }));
  }));
});
