import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { withTestDb } from './helpers/db.js';
import { accounts, adminAuditLog, operators } from '../src/db/schema.js';
import { verifyAuditChain } from '../src/admin/audit-log.js';

it('registers an existing account once, records it, and refuses overwrites or unknown accounts', () => withTestDb(async (db) => {
  const [a] = await db.insert(accounts).values({ emailHash: randomUUID(), emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const url = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
  url.pathname = `/${rows[0]!.name}`;
  const register = (id: string, role = 'reviewer') => execFileSync(process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/scripts/add-operator.ts', import.meta.url)), id, 'Operator@Example.com', role], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: url.toString(), EMAIL_ENC_KEY: Buffer.alloc(32, 1).toString('base64'), EMAIL_HASH_KEY: Buffer.alloc(32, 2).toString('base64'), APP_ORIGIN: 'http://localhost:5173', SMTP_URL: 'smtp://localhost:1025', ADMIN_EMAIL: 'admin@example.com', RP_ID: 'localhost' },
    });
  expect(register(a!.id).toString()).toContain('Operator registered.');
  expect(await db.select().from(operators)).toMatchObject([{ accountId: a!.id, role: 'reviewer', tailscaleLogin: 'operator@example.com' }]);
  expect(await db.select().from(adminAuditLog)).toMatchObject([{ action: 'operator.register', target: a!.id }]);
  expect(await verifyAuditChain(db)).toBeNull();
  expect(() => register(a!.id, 'owner')).toThrow();
  expect(() => register(randomUUID())).toThrow();
  expect(await db.select().from(operators)).toHaveLength(1);
  expect(await db.select().from(adminAuditLog)).toHaveLength(1);
}));
