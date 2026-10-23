import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { DatabaseWriteMode } from 'platform';
import { withTestDb, type TestDb } from './helpers/db.js';
import { createFakeMailer } from './helpers/fake-mailer.js';
import { accounts, appDatabases } from '../src/db/schema.js';
import { encryptEmail } from '../src/crypto/email.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { createApp } from '../src/apps/apps.js';
import { checkDatabaseSizes, targetWriteMode } from '../src/apps/database-watch.js';

const emailKey = randomBytes(32);
const MB = 1024 * 1024;

async function setup(db: TestDb) {
  const email = `w${randomUUID().slice(0, 8)}@x.y`;
  const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: encryptEmail(email, emailKey), displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `w-${randomUUID().slice(0, 8)}`, ownerId, kind: 'dynamic' }) as { appId: string };
  await db.insert(appDatabases).values({ appId, passwordEnc: 'x', status: 'ready' });
  return { appId, email };
}

/** A database whose size the test sets; records the write modes applied. */
function fakeDatabases() {
  let size = 0;
  const modes: DatabaseWriteMode[] = [];
  return {
    setSize: (n: number) => { size = n; },
    modes,
    databases: { sizeBytes: async () => size, setWriteMode: async (_a: string, _d: string, _u: string, m: DatabaseWriteMode) => { modes.push(m); } },
  };
}

describe('database size watch', () => {
  it('targetWriteMode: read-only from 100% until back under 80%, blocked beyond the hard limit', () => {
    expect(targetWriteMode(0.5, 'normal')).toBe('normal');
    expect(targetWriteMode(0.9, 'normal')).toBe('normal');
    expect(targetWriteMode(1.0, 'normal')).toBe('read_only');
    expect(targetWriteMode(0.9, 'read_only')).toBe('read_only'); // no flapping around 100%
    expect(targetWriteMode(0.79, 'read_only')).toBe('normal');
    expect(targetWriteMode(1.1, 'read_only')).toBe('blocked');
    expect(targetWriteMode(1.05, 'blocked')).toBe('blocked');
    expect(targetWriteMode(0.5, 'blocked')).toBe('normal');
  });

  it('mails once at 80% and once at 100% per month, switches modes and records the size', () => withTestDb(async (db) => {
    const s = await setup(db);
    const f = fakeDatabases();
    const mail = createFakeMailer();
    const run = (mb: number, now = new Date('2026-10-18T00:00:00Z')) => { f.setSize(mb * MB); return checkDatabaseSizes({ db, databases: f.databases, mailer: mail, emailKey, now, limitBytes: 100 * MB }); };

    await run(50);
    expect(mail.sentTo(s.email)).toBe(0);
    await run(85);
    await run(90);
    expect(mail.sentTo(s.email)).toBe(1);
    expect(mail.lastBodyTo(s.email)).toContain('85.0MB');
    expect(mail.lastBodyTo(s.email)).toContain('ブースト');
    await run(100);
    expect(mail.sentTo(s.email)).toBe(2);
    expect(f.modes).toEqual(['read_only']);
    await run(95);
    expect(f.modes).toEqual(['read_only']); // stays read-only
    await run(70);
    expect(f.modes).toEqual(['read_only', 'normal']);
    await run(100);
    expect(mail.sentTo(s.email)).toBe(2); // already mailed this month
    await run(100, new Date('2026-11-01T00:00:00Z'));
    expect(mail.sentTo(s.email)).toBe(3); // a new month
    const [row] = await db.select().from(appDatabases).where(eq(appDatabases.appId, s.appId));
    expect(row).toMatchObject({ sizeBytes: 100 * MB, writeMode: 'read_only', notifiedLevel: 100, notifiedMonth: '2026-11' });
  }));
});
