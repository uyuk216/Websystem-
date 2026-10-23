import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { t } from 'i18n';
import { withTestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, apps, grants, studentVerifications } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { createSession } from '../src/auth/sessions.js';
import { createApp } from '../src/http/app.js';
import { grantStudent } from '../src/grants/grants.js';
import { planGuidance } from '../src/usage/plan-guidance.js';

const config = { emailEncKey: Buffer.alloc(32, 1), emailHashKey: Buffer.alloc(32, 2), adminEmail: 'a@b.c', appOrigin: 'http://localhost:5173', rpId: 'localhost' };
describe('personal plan and review status', () => {
  it('requires a cookie and isolates plans, review reasons and expiry dates between accounts', () => withTestDb(async (db) => {
    const account = async () => {
      const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
      const ownerId = await ensureAccountOwner(db, a!.id);
      const session = await createSession(db, a!.id, 'test');
      return { id: a!.id, ownerId, headers: { cookie: `sid=${session.token}` } };
    };
    const a = await account(), b = await account();
    const app = createApp({ db, mailer: createFakeMailer(), config });
    for (const path of ['/plan', '/verification/status']) expect((await app.request(path)).status).toBe(401);
    const get = async (path: string, user = a) => {
      const r = await app.request(path, { headers: user.headers });
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toBe('no-store');
      return r.json();
    };
    expect(await get('/plan')).toEqual({ plan: 'none', endsAt: null, suspendOn: null });
    expect(await get('/verification/status')).toEqual({ verification: null });
    const [site] = await db.insert(apps).values({ ownerId: a.ownerId, name: `p-${randomUUID().slice(0, 8)}` }).returning();
    const path = `/apps/${site!.id}/plan-guidance?locale=en`;
    expect(await get(path)).toEqual({ guidance: t('en', 'plan.help.none') });
    expect((await app.request(path, { headers: b.headers })).status).toBe(404);
    expect((await app.request(path)).status).toBe(401);
    const [review] = await db.insert(studentVerifications).values({ accountId: a.id, schoolName: 'School', schoolKind: 'university', expectedGraduationYear: 2099, status: 'rejected', rejectReason: '学校名を確認してください' }).returning();
    expect(await get('/verification/status')).toMatchObject({ verification: { status: 'rejected', rejectReason: '学校名を確認してください' } });
    expect(await get('/verification/status', b)).toEqual({ verification: null });
    const until = new Date('2099-03-31T14:59:59.999Z');
    await db.update(studentVerifications).set({ status: 'approved', rejectReason: null, validUntil: until }).where(eq(studentVerifications.id, review!.id));
    await grantStudent(db, a.id, until);
    expect(await get('/plan')).toMatchObject({ plan: 'student', endsAt: until.toISOString(), suspendOn: '2099-04-30T15:00:00.000Z' });
    expect(await get('/verification/status')).toMatchObject({ verification: { status: 'approved', rejectReason: null, validUntil: until.toISOString() } });
    expect(await get('/plan', b)).toMatchObject({ plan: 'none' });
    for (const locale of ['ja', 'en'] as const) {
      expect(await planGuidance(db, a.ownerId, locale)).toBe(t(locale, 'plan.help.student'));
      expect(await planGuidance(db, b.ownerId, locale)).toBe(t(locale, 'plan.help.none'));
    }
    await db.insert(grants).values({ kind: 'starter', targetKind: 'account', targetId: a.id, startsAt: new Date(), endsAt: until, approvedBy: 'system' });
    expect(await get('/plan')).toMatchObject({ plan: 'starter' });
    expect(await planGuidance(db, a.ownerId, 'en')).toBe(t('en', 'plan.help.starter'));
    const past = new Date('2020-03-31T14:59:59.999Z');
    await db.update(grants).set({ startsAt: new Date('2019-04-01'), endsAt: past, suspendOn: new Date('2020-04-30T15:00:00Z') }).where(eq(grants.targetId, a.id));
    expect(await get('/plan')).toEqual({ plan: 'none', endsAt: past.toISOString(), suspendOn: '2020-04-30T15:00:00.000Z' });
  }));
});
