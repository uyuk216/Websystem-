import { randomUUID } from 'node:crypto';
import { enqueueOutbox } from '../security/outbox.js';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { accounts, apps, owners, teamMembers, securityAppeals, securityBlocks, securityIncidents } from '../db/schema.js';
import { appendSecurityAudit } from '../security/incidents.js';
import { reconcileAccountSecurity } from '../security/reconcile.js';
import { incidentAccount } from '../security/appeals.js';
import { refreshAccountOwners } from './accounts.js';
import { auditedSystem } from './operations.js';
import type { AdminDeps } from './server.js';
import { jsonBody, validId } from './validation.js';

export function registerSecurity(app: Hono, deps: AdminDeps, ownerOnly: MiddlewareHandler): void {
  app.get('/admin/security', async (c) => c.json({ incidents: await auditedSystem(deps.db, c.get('operator'), { action: 'security.list', target: '*' }, (db) => db.select().from(securityIncidents).orderBy(desc(securityIncidents.createdAt)).limit(100)) }));
  app.get('/admin/security/:id', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid' }, 400);
    const result = await auditedSystem(deps.db, c.get('operator'), { action: 'security.view', target: id }, async (db) => {
      const [incident] = await db.select().from(securityIncidents).where(eq(securityIncidents.id, id));
      if (!incident) return null;
      const accountId = await incidentAccount(db as unknown as Parameters<typeof incidentAccount>[0], incident);
      const [owner] = accountId ? await db.select({ id: owners.id }).from(owners).where(eq(owners.accountId, accountId)) : [];
      return { incident, unfreezeOwnerId: owner?.id ?? null, blocks: await db.select().from(securityBlocks).where(eq(securityBlocks.incidentId, id)), appeals: await db.select().from(securityAppeals).where(eq(securityAppeals.incidentId, id)) };
    });
    return result ? c.json(result) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/admin/security/:id/:action', ownerOnly, async (c) => {
    const id = c.req.param('id'), action = c.req.param('action'), body = await jsonBody(c);
    if (!validId(id) || !['release', 'continue', 'freeze'].includes(action) || typeof body?.reason !== 'string' || !body.reason.trim() || body.reason.length > 500) return c.json({ error: 'invalid' }, 400);
    const found = await auditedSystem(deps.db, c.get('operator'), { action: `security.${action}`, target: id, detail: { reason: body.reason } }, async (db) => {
      const [initial] = await db.select().from(securityIncidents).where(eq(securityIncidents.id, id));
      if (!initial) return false;
      const freezeAccount = action === 'freeze' ? await incidentAccount(db as unknown as Parameters<typeof incidentAccount>[0], initial) : null;
      if (freezeAccount) await db.select().from(accounts).where(eq(accounts.id, freezeAccount)).for('update');
      // Match ingestion lock order: target first, then incident; new incidents cannot race account reconciliation.
      if (initial.accountId) await db.select().from(accounts).where(eq(accounts.id, initial.accountId)).for('update');
      if (initial.appId) await db.select().from(apps).where(eq(apps.id, initial.appId)).for('update');
      const [incident] = await db.select().from(securityIncidents).where(eq(securityIncidents.id, id)).for('update');
      if (action === 'continue' && incident!.status !== 'open') return false;
      if (action === 'release') {
        await db.update(securityBlocks).set({ releasedAt: new Date(), releasedBy: c.get('operator').accountId, releaseNote: body.reason as string }).where(and(eq(securityBlocks.incidentId, id), isNull(securityBlocks.releasedAt)));
        await db.update(securityIncidents).set({ status: 'resolved', updatedAt: new Date() }).where(eq(securityIncidents.id, id));
        if (incident!.accountId) await reconcileAccountSecurity(db, incident!.accountId);
        // Never starts a container: the existing waker rechecks quota, manual and all other incident reasons.
      } else if (action === 'freeze') {
        const accountId = await incidentAccount(db as unknown as Parameters<typeof incidentAccount>[0], incident!);
        if (!accountId) return false;
        await db.select().from(accounts).where(eq(accounts.id, accountId)).for('update');
        await refreshAccountOwners(db, accountId, 'security_freeze', {});
        const teams = db.select({ id: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.accountId, accountId), eq(teamMembers.role, 'owner')));
        const owned = db.select({ id: owners.id }).from(owners).where(sql`${owners.accountId} = ${accountId} OR ${owners.teamId} IN (${teams})`);
        const dynamic = await db.select({ id: apps.id }).from(apps).where(and(inArray(apps.ownerId, owned), eq(apps.kind, 'dynamic')));
        const operation = randomUUID();
        for (const app of dynamic) await enqueueOutbox(db as unknown as Parameters<typeof enqueueOutbox>[0], { incidentId: id, kind: 'stop_app', effectKey: `freeze:${operation}:${app.id}`, payload: { appId: app.id } });
      }
      await appendSecurityAudit(db as unknown as Parameters<typeof appendSecurityAudit>[0], id, `incident.${action}`, {});
      await db.execute(sql`select pg_notify('security_block', '')`);
      return true;
    });
    return found ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404);
  });
}
