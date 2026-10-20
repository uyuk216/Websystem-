import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { endOfMarchJst } from 'shared';
import { encryptEmail } from '../src/crypto/email.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apps, studentVerifications, usageStates } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { grantStudent, revokeGrant } from '../src/grants/grants.js';
import { evaluateDueOwners, readUsageState, sendReregistrationNotices, transitionUsageState } from '../src/usage/state.js';
import { runtimeBlockedUntil } from '../src/usage/runtime-hours.js';
import { grants } from '../src/db/schema.js';

const KEY = Buffer.alloc(32, 9);
const jst = (s: string) => new Date(`${s}+09:00`);
let n = 0;

async function acct(db: TestDb, locale = 'ja') {
  const email = `u${n++}-${randomUUID().slice(0, 6)}@example.com`;
  const [a] = await db.insert(accounts).values({ emailHash: email, emailEnc: encryptEmail(email, KEY), displayName: 'A', locale, adultFrom: '2030-01' }).returning();
  return { id: a!.id, email, ownerId: await ensureAccountOwner(db, a!.id) };
}
async function app(db: TestDb, ownerId: string, kind: 'static' | 'dynamic') {
  const [r] = await db.insert(apps).values({ ownerId, name: `a-${randomUUID().slice(0, 8)}`, kind }).returning();
  return r!.id;
}
const fakeDriver = () => { const stopped: string[] = []; return { stopped, stop: async (id: string) => { stopped.push(id); } }; };
const student2026 = async (db: TestDb, accountId: string) => grantStudent(db, accountId, endOfMarchJst(2027), { startsAt: jst('2026-10-01T00:00:00') });

describe('transitionUsageState: 年度の切り替え', () => {
  it('3/31 -> 4/1 に猶予（動かしたまま）、5/1 に停止（コンテナだけ止め、データは残す）、再登録で再開', () => withTestDb(async (db) => {
    const a = await acct(db);
    await student2026(db, a.id);
    const dyn = await app(db, a.ownerId, 'dynamic');
    const stat = await app(db, a.ownerId, 'static');
    const driver = fakeDriver();
    const mailer = createFakeMailer();
    const opts = { driver, mailer, emailKey: KEY };

    expect(await readUsageState(db, a.ownerId)).toBe('active');
    expect((await transitionUsageState(db, a.ownerId, 'month_start_reset', { ...opts, now: jst('2027-03-01T00:00:00') })).state).toBe('active');

    const grace = await transitionUsageState(db, a.ownerId, 'fiscal_year_rollover', { ...opts, now: jst('2027-04-01T00:00:00') });
    expect(grace).toMatchObject({ previous: 'active', state: 'grace', changed: true, stoppedApps: 0 });
    expect(driver.stopped).toEqual([]);
    expect(await runtimeBlockedUntil(db, a.ownerId, jst('2027-04-15T12:00:00'))).toBeNull(); // 猶予の間は前のプランの上限で動く
    expect(mailer.sentTo(a.email)).toBe(1);
    expect(mailer.lastBodyTo(a.email)).toContain('2027年4月30日');

    const [row] = await db.select().from(usageStates).where(eq(usageStates.ownerId, a.ownerId));
    // 認証の有効期限と停止する日は別々の列
    expect(row).toMatchObject({ validUntil: endOfMarchJst(2027), suspendOn: jst('2027-05-01T00:00:00'), nextEvaluateAt: jst('2027-05-01T00:00:00') });

    const sus = await transitionUsageState(db, a.ownerId, 'grant_expired', { ...opts, now: jst('2027-05-01T00:00:00') });
    expect(sus).toMatchObject({ previous: 'grace', state: 'suspended', stoppedApps: 1 });
    expect(driver.stopped).toEqual([dyn]); // 動的アプリだけ。静的サイトは止めない
    expect(mailer.sentTo(a.email)).toBe(2);
    expect(await runtimeBlockedUntil(db, a.ownerId, jst('2027-05-01T00:00:01'))).not.toBeNull();
    // データは消さない
    expect((await db.select().from(apps).where(eq(apps.ownerId, a.ownerId))).map((r) => r.id).sort()).toEqual([dyn, stat].sort());

    // 再登録 -> 再開（コンテナは次のアクセスで起こされるので、ここでは「もう止めない」ことだけ）
    await grantStudent(db, a.id, endOfMarchJst(2028), { startsAt: jst('2027-05-10T00:00:00') });
    const back = await transitionUsageState(db, a.ownerId, 'reregistered', { ...opts, now: jst('2027-05-10T00:00:00') });
    expect(back).toMatchObject({ previous: 'suspended', state: 'active', stoppedApps: 0 });
    expect(await runtimeBlockedUntil(db, a.ownerId, jst('2027-05-10T00:00:01'))).toBeNull();
    expect(driver.stopped).toEqual([dyn]);
  }));

  it('猶予の最中の再登録は、そのまま有効に戻る（停止しない）', () => withTestDb(async (db) => {
    const a = await acct(db);
    await student2026(db, a.id);
    await transitionUsageState(db, a.ownerId, 'fiscal_year_rollover', { now: jst('2027-04-01T00:00:00') });
    await grantStudent(db, a.id, endOfMarchJst(2028), { startsAt: jst('2027-04-20T00:00:00') });
    expect((await transitionUsageState(db, a.ownerId, 'reregistered', { now: jst('2027-04-20T00:00:00') })).state).toBe('active');
    expect((await transitionUsageState(db, a.ownerId, 'grant_expired', { now: jst('2027-05-01T00:00:00') })).state).toBe('active');
  }));

  it('同じ日に年度の切り替え + 月初 + 付与の期限が重なっても、順番によらず同じ結果', () => withTestDb(async (db) => {
    const orders: ('fiscal_year_rollover' | 'month_start_reset' | 'grant_expired')[][] = [
      ['fiscal_year_rollover', 'month_start_reset', 'grant_expired'], ['grant_expired', 'month_start_reset', 'fiscal_year_rollover'],
      ['month_start_reset', 'grant_expired', 'fiscal_year_rollover'], ['grant_expired', 'grant_expired', 'month_start_reset'],
    ];
    for (const day of ['2027-04-01T00:00:00', '2027-05-01T00:00:00']) {
      const results: unknown[] = [];
      for (const order of orders) {
        const a = await acct(db);
        await student2026(db, a.id);
        const driver = fakeDriver();
        await app(db, a.ownerId, 'dynamic');
        let last;
        for (const e of order) last = await transitionUsageState(db, a.ownerId, e, { driver, now: jst(day) });
        const [row] = await db.select().from(usageStates).where(eq(usageStates.ownerId, a.ownerId));
        results.push({ state: last!.state, reasons: last!.reasons, next: row!.nextEvaluateAt?.toISOString() ?? null, stopped: driver.stopped.length > 0 });
      }
      for (const r of results) expect(r).toEqual(results[0]);
      expect(results[0]).toMatchObject({ state: day.startsWith('2027-04') ? 'grace' : 'suspended' });
    }
  }));

  it('上位の理由が残る間は解除されない（凍結 > ブロック > 停止 > 猶予）', () => withTestDb(async (db) => {
    const a = await acct(db);
    await student2026(db, a.id);
    const at = (s: string) => ({ now: jst(s) });
    expect((await transitionUsageState(db, a.ownerId, 'grant_expired', at('2027-05-02T00:00:00'))).state).toBe('suspended');
    expect((await transitionUsageState(db, a.ownerId, 'manual_block', at('2027-05-02T01:00:00'))).state).toBe('blocked');
    expect((await transitionUsageState(db, a.ownerId, 'manual_freeze', at('2027-05-02T02:00:00'))).state).toBe('frozen');
    // 再登録しても凍結・ブロックは解けない
    await grantStudent(db, a.id, endOfMarchJst(2028), { startsAt: jst('2027-05-03T00:00:00') });
    expect((await transitionUsageState(db, a.ownerId, 'reregistered', at('2027-05-03T00:00:00'))).state).toBe('frozen');
    expect((await transitionUsageState(db, a.ownerId, 'manual_unfreeze', at('2027-05-04T00:00:00'))).state).toBe('blocked');
    expect((await transitionUsageState(db, a.ownerId, 'manual_unblock', at('2027-05-04T01:00:00'))).state).toBe('active');
    expect(await readUsageState(db, a.ownerId)).toBe('active');
  }));

  it('付与の取り消しで停止、ブロックはコンテナを止める。凍結・ブロックの解除後に期限切れなら停止に戻る', () => withTestDb(async (db) => {
    const a = await acct(db);
    await student2026(db, a.id);
    const dyn = await app(db, a.ownerId, 'dynamic');
    const driver = fakeDriver();
    const [g] = await db.select().from(grants);
    await revokeGrant(db, g!.id, jst('2027-01-10T00:00:00'));
    const r = await transitionUsageState(db, a.ownerId, 'grant_revoked', { driver, now: jst('2027-01-10T00:00:00') });
    expect(r).toMatchObject({ state: 'suspended', reasons: ['grant_revoked'], stoppedApps: 1 });
    expect(driver.stopped).toEqual([dyn]);
    const b = await acct(db);
    const d2 = await app(db, b.ownerId, 'dynamic');
    expect((await transitionUsageState(db, b.ownerId, 'manual_block', { driver, now: jst('2027-01-10T00:00:00') })).stoppedApps).toBe(1);
    expect(driver.stopped).toEqual([dyn, d2]);
  }));

  it('付与のないオーナー（無料プランに入ったことがない）は評価しても有効のまま', () => withTestDb(async (db) => {
    const a = await acct(db);
    expect((await transitionUsageState(db, a.ownerId, 'fiscal_year_rollover', { now: jst('2027-05-01T00:00:00') })).state).toBe('active');
  }));

  it('pro_started（予約）: 有料になったオーナーは 5/1 に止まらない', () => withTestDb(async (db) => {
    const a = await acct(db);
    await student2026(db, a.id);
    await transitionUsageState(db, a.ownerId, 'pro_started', { now: jst('2027-02-01T00:00:00') });
    expect((await transitionUsageState(db, a.ownerId, 'grant_expired', { now: jst('2027-05-01T00:00:00') })).state).toBe('active');
  }));
});

describe('evaluateDueOwners（ワーカーの毎時の評価）', () => {
  it('5/1 に再登録していない人の動的アプリだけが止まる。再登録済み・有効な付与がある人・付与のない人は止まらない', () => withTestDb(async (db) => {
    const lapsed = await acct(db), renewed = await acct(db), nogrant = await acct(db), valid = await acct(db);
    await student2026(db, lapsed.id);
    await student2026(db, renewed.id);
    await grantStudent(db, renewed.id, endOfMarchJst(2028), { startsAt: jst('2027-03-20T00:00:00') });
    await grantStudent(db, valid.id, endOfMarchJst(2028), { startsAt: jst('2026-10-01T00:00:00') });
    const ids = {
      lapsed: await app(db, lapsed.ownerId, 'dynamic'), lapsedStatic: await app(db, lapsed.ownerId, 'static'),
      renewed: await app(db, renewed.ownerId, 'dynamic'), nogrant: await app(db, nogrant.ownerId, 'dynamic'), valid: await app(db, valid.ownerId, 'dynamic'),
    };
    const driver = fakeDriver();
    const mailer = createFakeMailer();

    // 4/2: lapsed だけが猶予に入る（動かしたまま、メール 1 通）。
    expect(await evaluateDueOwners(db, { driver, mailer, emailKey: KEY, now: jst('2027-04-02T00:30:00') })).toBe(1);
    expect(driver.stopped).toEqual([]);
    expect(mailer.sentTo(lapsed.email)).toBe(1);
    expect(await readUsageState(db, lapsed.ownerId)).toBe('grace');
    // もう一度評価しても（猶予の最中は次の評価が 5/1 なので）何も起きず、メールは重複しない。
    expect(await evaluateDueOwners(db, { driver, mailer, emailKey: KEY, now: jst('2027-04-20T00:00:00') })).toBe(0);
    expect(mailer.sentTo(lapsed.email)).toBe(1);

    // 5/1: lapsed の動的アプリだけが止まる。
    expect(await evaluateDueOwners(db, { driver, mailer, emailKey: KEY, now: jst('2027-05-01T00:05:00') })).toBe(1);
    expect(driver.stopped).toEqual([ids.lapsed]);
    expect(await readUsageState(db, lapsed.ownerId)).toBe('suspended');
    for (const o of [renewed, valid, nogrant]) expect(await readUsageState(db, o.ownerId)).toBe('active');
    expect(await evaluateDueOwners(db, { driver, mailer, emailKey: KEY, now: jst('2027-05-02T00:00:00') })).toBe(0);
    expect(driver.stopped).toHaveLength(1);
  }));
});

describe('sendReregistrationNotices（3 月の再登録の案内）', () => {
  it('3 月に Student が年度末で切れる人へ、年度ごとに 1 回だけ。卒業予定年を過ぎた人には別の案内（日英）', () => withTestDb(async (db) => {
    const ja = await acct(db), en = await acct(db, 'en'), later = await acct(db);
    for (const a of [ja, en, later]) await student2026(db, a.id);
    await grantStudent(db, later.id, endOfMarchJst(2028), { startsAt: jst('2027-02-01T00:00:00') }); // 再登録済み
    await db.insert(studentVerifications).values({ accountId: en.id, schoolName: 'X', schoolKind: 'university', expectedGraduationYear: 2027, status: 'approved', reviewedAt: jst('2026-10-01T00:00:00') });
    await db.insert(studentVerifications).values({ accountId: ja.id, schoolName: 'X', schoolKind: 'university', expectedGraduationYear: 2029, status: 'approved', reviewedAt: jst('2026-10-01T00:00:00') });
    const mailer = createFakeMailer();
    const deps = { mailer, emailKey: KEY };

    expect(await sendReregistrationNotices(db, { ...deps, now: jst('2027-02-28T23:00:00') })).toBe(0); // 2 月はまだ
    expect(await sendReregistrationNotices(db, { ...deps, now: jst('2027-03-01T00:10:00') })).toBe(2);
    expect(mailer.lastBodyTo(ja.email)).toContain('2027年4月30日までに学生証の審査');
    expect(mailer.lastBodyTo(en.email)).toContain('expected graduation year (2027)');
    expect(mailer.lastBodyTo(en.email)).toContain('April 30, 2027');
    expect(mailer.sentTo(later.email)).toBe(0);
    expect(await sendReregistrationNotices(db, { ...deps, now: jst('2027-03-15T00:00:00') })).toBe(0); // 重複して送らない
    expect(mailer.sentTo(ja.email)).toBe(1);
  }));
});
