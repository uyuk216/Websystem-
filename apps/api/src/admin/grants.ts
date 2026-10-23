import { desc, eq, like } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { grants, accounts, adminAuditLog } from '../db/schema.js';
import { grantStudent, revokeGrant } from '../grants/grants.js';
import { approveStarter, rejectStarter, listPendingStarterApplications } from '../grants/starter.js';
import { approveEventBoost, rejectEventBoost, listPendingEventBoosts } from '../grants/event-boost.js';
import type { AdminDeps } from './server.js';
import { refreshAccountOwners } from './accounts.js';
import { auditedSystem } from './operations.js';
import { jsonBody, validId, respond } from './validation.js';

export function registerGrants(app: Hono, deps: AdminDeps, ownerOnly: MiddlewareHandler): void {
  app.get('/admin/grants', async (c) => c.json(await auditedSystem(deps.db, c.get('operator'), { action: 'grants.list', target: '*' }, async (db) => ({
    grants: await db.select().from(grants).orderBy(desc(grants.createdAt)).limit(200),
    history: await db.select().from(adminAuditLog).where(like(adminAuditLog.action, 'grants.%')).orderBy(desc(adminAuditLog.seq)).limit(200),
    starter: await listPendingStarterApplications(db), boosts: await listPendingEventBoosts(db),
  }))));
  app.post('/admin/grants/student', ownerOnly, async (c) => {
    const b = await jsonBody(c), until = new Date(typeof b?.validUntil === 'string' ? b.validUntil : '');
    if (typeof b?.accountId !== 'string' || !validId(b.accountId) || !Number.isFinite(until.getTime()) || until <= new Date() || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 500) return c.json({ error: 'invalid' }, 400);
    return respond(c, await auditedSystem(deps.db, c.get('operator'), { action: 'grants.student', target: b.accountId, detail: { validUntil: until.toISOString() } }, async (db) => {
      const [a] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, b.accountId as string));
      if (!a) return { error: 'not_found' };
      await grantStudent(db, a.id, until, { approvedBy: c.get('operator').accountId, reason: b.reason as string });
      await refreshAccountOwners(db, a.id, 'reregistered', deps);
      return { ok: true };
    }));
  });
  app.post('/admin/grants/:id/revoke', ownerOnly, async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid' }, 400);
    return respond(c, await auditedSystem(deps.db, c.get('operator'), { action: 'grants.revoke', target: id }, async (db) => {
      const [g] = await db.select().from(grants).where(eq(grants.id, id));
      if (!g || g.kind !== 'student') return { error: 'not_found' };
      await revokeGrant(db, id);
      await refreshAccountOwners(db, g.targetId, 'grant_revoked', deps);
      return { ok: true };
    }));
  });
  app.post('/admin/grants/:kind/:id/:decision', ownerOnly, async (c) => {
    const { kind, id, decision } = c.req.param(), b = await jsonBody(c);
    if (!validId(id!) || !b || !['starter', 'boost'].includes(kind!) || !['approve', 'reject'].includes(decision!)) return c.json({ error: 'invalid' }, 400);
    if (decision === 'reject' && typeof b.reason !== 'string') return c.json({ error: 'invalid' }, 400);
    if (kind === 'boost' && ['extraTransferBytes', 'extraMemoryMb', 'anomalyThresholdMultiplier'].some((key) => b[key] !== undefined && (typeof b[key] !== 'number' || !Number.isFinite(b[key])))) return c.json({ error: 'invalid' }, 400);
    const op = c.get('operator');
    return respond(c, await auditedSystem(deps.db, op, { action: `grants.${kind}.${decision}`, target: id! }, async (db) => {
      const opts = { approvedBy: op.accountId, reviewedBy: op.accountId, mailer: deps.mailer, emailKey: deps.emailEncKey, driver: deps.driver };
      if (kind === 'starter') return decision === 'approve' ? approveStarter(db, id!, new Date(typeof b.endsAt === 'string' ? b.endsAt : ''), opts) : rejectStarter(db, id!, b.reason as string, opts);
      return decision === 'approve' ? approveEventBoost(db, id!, b as { extraTransferBytes?: number; extraMemoryMb?: number; anomalyThresholdMultiplier?: number }, opts) : rejectEventBoost(db, id!, b.reason as string, opts);
    }));
  });
}
