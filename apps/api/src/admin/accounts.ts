import { and, eq, or, inArray } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Db } from '../db/client.js';
import type { UsageEvent } from 'shared';
import { accounts, owners, teamMembers, usageStates } from '../db/schema.js';
import { decryptEmail, hashEmail, normalizeEmail } from '../crypto/email.js';
import { transitionUsageState } from '../usage/state.js';
import type { AdminDeps } from './server.js';
import { auditedSystem } from './operations.js';
import { jsonBody, validId } from './validation.js';

/** Personal and team owners inherit account grants; update both immediately. */
export async function refreshAccountOwners(db: Db, accountId: string, event: UsageEvent, deps: Pick<AdminDeps, 'driver'>): Promise<void> {
  const teams = db.select({ id: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.accountId, accountId), eq(teamMembers.role, 'owner')));
  const rows = await db.select({ id: owners.id }).from(owners).where(or(eq(owners.accountId, accountId), inArray(owners.teamId, teams)));
  for (const row of rows) await transitionUsageState(db, row.id, event, { driver: deps.driver });
}
export function registerAccounts(app: Hono, deps: AdminDeps, ownerOnly: MiddlewareHandler): void {
  // POST keeps the exact email out of URLs, browser history and access logs. Never audit the query or plaintext.
  app.post('/admin/accounts/search', ownerOnly, async (c) => {
    const b = await jsonBody(c);
    if (!b || (typeof b.email !== 'string' && typeof b.accountId !== 'string') || (b.accountId !== undefined && (typeof b.accountId !== 'string' || !validId(b.accountId)))) return c.json({ error: 'invalid' }, 400);
    if (typeof b.email === 'string' && (!deps.emailHashKey || b.email.length > 320 || !b.email.includes('@'))) return c.json({ error: 'invalid' }, 400);
    const rows = await auditedSystem(deps.db, c.get('operator'), { action: 'accounts.search', target: '*' }, async (db) => {
      const found = await db.select({ id: accounts.id, displayName: accounts.displayName }).from(accounts).where(typeof b.email === 'string' ? eq(accounts.emailHash, hashEmail(normalizeEmail(b.email), deps.emailHashKey!)) : eq(accounts.id, b.accountId as string)).limit(1);
      return Promise.all(found.map(async (a) => ({ ...a, owners: await db.select({ id: owners.id, state: usageStates.state, reasons: usageStates.reasons }).from(owners).leftJoin(usageStates, eq(usageStates.ownerId, owners.id)).where(eq(owners.accountId, a.id)) })));
    });
    return c.json({ accounts: rows });
  });
  app.get('/admin/accounts/:id/email', ownerOnly, async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid' }, 400);
    const email = await auditedSystem(deps.db, c.get('operator'), { action: 'accounts.email', target: id }, async (db) => {
      const [a] = await db.select({ enc: accounts.emailEnc }).from(accounts).where(eq(accounts.id, id));
      return a ? decryptEmail(a.enc, deps.emailEncKey) : null;
    });
    return email ? c.json({ email }) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/admin/accounts/:id/state', ownerOnly, async (c) => {
    const id = c.req.param('id'), b = await jsonBody(c);
    const events = ['manual_block', 'manual_unblock', 'manual_freeze', 'manual_suspend', 'manual_resume'];
    if (!validId(id) || typeof b?.event !== 'string' || !events.includes(b.event)) return c.json({ error: 'invalid' }, 400);
    const r = await auditedSystem(deps.db, c.get('operator'), { action: `accounts.${b.event}`, target: id }, async (db) => {
      const [owner] = await db.select({ id: owners.id }).from(owners).where(eq(owners.id, id));
      return owner ? transitionUsageState(db, id, b.event as UsageEvent, { driver: deps.driver }) : null;
    });
    return r ? c.json(r) : c.json({ error: 'not_found' }, 404);
  });
}
