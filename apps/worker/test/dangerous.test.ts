import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JOBS } from 'platform';
import { withTestDb } from '../../api/test/helpers/db.js';
import { createFakeMailer } from '../../api/test/helpers/fake-mailer.js';
import { accounts, operators, scheduledDangerousActions } from '../../api/src/db/schema.js';
import { ensureAccountOwner } from '../../api/src/teams/teams.js';
import { readUsageState, transitionUsageState } from '../../api/src/usage/state.js';
import { scheduleDangerous } from '../../api/src/admin/dangerous.js';
import { defaultDangerousHandlers } from '../../api/src/admin/server.js';
import { defaultHandlers } from '../src/worker.js';
import { encryptEmail } from '../../api/src/crypto/email.js';

it('scheduled executor leaves freeze before 24h, executes once when due, and retains other reasons', () => withTestDb(async (db) => {
  const key = Buffer.alloc(32, 1), email = `${randomUUID()}@example.com`;
  const [a] = await db.insert(accounts).values({ emailHash: email, emailEnc: encryptEmail(email, key), displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  await db.insert(operators).values({ accountId: a!.id, role: 'owner', tailscaleLogin: 'owner@tailnet' });
  const ownerId = await ensureAccountOwner(db, a!.id);
  await transitionUsageState(db, ownerId, 'manual_block');
  await transitionUsageState(db, ownerId, 'manual_freeze');
  const now = new Date();
  await scheduleDangerous(db, createFakeMailer(), key, defaultDangerousHandlers, { accountId: a!.id, role: 'owner', tailscaleLogin: 'owner@tailnet' }, { action: 'unfreeze_account', target: ownerId }, now);
  let at = new Date(now.getTime() + 23 * 3600_000);
  const handlers = defaultHandlers({ db, storage: {} as never, now: () => at });
  await handlers[JOBS.dangerousExecute]({});
  expect(await readUsageState(db, ownerId)).toBe('frozen');
  at = new Date(now.getTime() + 25 * 3600_000);
  await handlers[JOBS.dangerousExecute]({});
  expect(await readUsageState(db, ownerId)).toBe('blocked');
  await handlers[JOBS.dangerousExecute]({});
  expect((await db.select().from(scheduledDangerousActions))[0]!.status).toBe('executed');
}));

describe('schedule configuration', () => {
  it('registers a handler for the dangerous queue', () => {
    expect(defaultHandlers()[JOBS.dangerousExecute]).toBeTypeOf('function');
  });
});
