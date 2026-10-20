import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JOBS } from 'platform';
import { endOfMarchJst } from '../../../packages/shared/src/index.js';
import { withTestDb } from '../../api/test/helpers/db.js';
import { accounts, apps } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { grantStudent } from '../../api/src/grants/grants.js';
import { defaultHandlers } from '../src/worker.js';

const jst = (s: string) => new Date(`${s}+09:00`);

describe('usage.evaluate job', () => {
  it('停止日（5/1）を過ぎた再登録のないオーナーの動的アプリを止め、状態を suspended にする', () => withTestDb(async (db) => {
    const [a] = await db.insert(accounts).values({ emailHash: `w-${randomUUID()}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
    const ownerId = await ensureAccountOwner(db, a!.id);
    await grantStudent(db, a!.id, endOfMarchJst(2027), { startsAt: jst('2026-10-01T00:00:00') });
    const [app] = await db.insert(apps).values({ ownerId, name: `d-${randomUUID().slice(0, 8)}`, kind: 'dynamic' }).returning();
    const stopped: string[] = [];
    const runtime = { driver: { stop: async (id: string) => { stopped.push(id); } } } as never;
    const handlers = defaultHandlers({ db, storage: {} as never, runtime, now: () => jst('2027-05-01T00:10:00') });
    await handlers[JOBS.usageEvaluate]({});
    expect(stopped).toEqual([app!.id]);
    const [row] = await db.$client`SELECT state, reasons FROM usage_states WHERE owner_id = ${ownerId}`;
    expect(row).toMatchObject({ state: 'suspended', reasons: ['not_reregistered'] });
    await handlers[JOBS.usageEvaluate]({}); // 2 回目は何も起きない
    expect(stopped).toHaveLength(1);
  }));
});
