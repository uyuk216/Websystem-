import type { Hono } from 'hono';
import type { AdminDeps } from './server.js';
import { auditedSystem } from './operations.js';
import { approveVerification, rejectVerification, listPendingReviews } from '../verification/review.js';
import { jsonBody, validId, respond } from './validation.js';
import { refreshAccountOwners } from './accounts.js';

export function registerReviews(app: Hono, deps: AdminDeps): void {
  app.get('/admin/reviews', async (c) => c.json({ reviews: await auditedSystem(deps.db, c.get('operator'), { action: 'reviews.list', target: '*' }, listPendingReviews) }));
  app.get('/admin/reviews/:id/image', async (c) => {
    const id = c.req.param('id');
    if (!validId(id)) return c.json({ error: 'invalid' }, 400);
    if (!deps.review) return c.json({ error: 'unavailable' }, 503);
    const image = await auditedSystem(deps.db, c.get('operator'), { action: 'reviews.image', target: id }, async (db) => {
      const pending = (await listPendingReviews(db)).find((r) => r.verificationId === id);
      if (!pending) return null;
      const ciphertext = await deps.review!.readCiphertext(pending.uploadId, pending.accountId);
      return ciphertext ? { uploadId: pending.uploadId, accountId: pending.accountId, ciphertext: Buffer.from(ciphertext).toString('base64') } : null;
    });
    return image ? c.json(image) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/admin/reviews/:id/:decision', async (c) => {
    const id = c.req.param('id'), decision = c.req.param('decision'), b = await jsonBody(c);
    if (!validId(id) || !b || !['approve', 'reject'].includes(decision)) return c.json({ error: 'invalid' }, 400);
    if (!deps.review) return c.json({ error: 'unavailable' }, 503);
    if (decision === 'reject' && typeof b.reason !== 'string') return c.json({ error: 'invalid' }, 400);
    const result = await auditedSystem(deps.db, c.get('operator'), { action: `reviews.${decision}`, target: id }, async (db) => {
      const pending = (await listPendingReviews(db)).find((r) => r.verificationId === id);
      const args = { verificationId: id, operatorId: c.get('operator').accountId };
      const d = { ...deps.review!, mailer: deps.mailer, emailKey: deps.emailEncKey };
      const r = decision === 'approve' ? await approveVerification(db, d, { ...args, newFiscalYearDocConfirmed: b.newFiscalYearDocConfirmed === true })
        : await rejectVerification(db, d, { ...args, reason: b.reason as string });
      if ('ok' in r && pending && decision === 'approve') await refreshAccountOwners(db, pending.accountId, 'reregistered', deps);
      return r;
    });
    return respond(c, result);
  });
}
