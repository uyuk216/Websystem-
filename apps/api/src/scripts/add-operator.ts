import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { assertOwnerBypassesRls, createDb } from '../db/client.js';
import { accounts, adminAuditLog, operators } from '../db/schema.js';

// Server console only. No public registration route, no email addresses in output or audit.
const [accountId, login, role] = process.argv.slice(2);
if (!accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)
  || !login?.trim() || login.length > 320 || (role !== 'owner' && role !== 'reviewer')) {
  throw new Error('Usage: add-operator <account UUID> <Tailscale login> <owner|reviewer>');
}
const { db, sql } = createDb(loadConfig(process.env).databaseUrl);
try {
  await assertOwnerBypassesRls(db);
  await db.transaction(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId));
    if (!account) throw new Error('Account not found');
    // Insertion only: changing existing operators requires a separate, reviewed operation.
    await tx.insert(operators).values({ accountId, tailscaleLogin: login.trim().toLowerCase(), role });
    await tx.insert(adminAuditLog).values({ seq: 0, operatorId: accountId, action: 'operator.register', target: accountId, detail: { role, source: 'server-console' } });
  });
  console.log('Operator registered.');
} finally { await sql.end(); }
