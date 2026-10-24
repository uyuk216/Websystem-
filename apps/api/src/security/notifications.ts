import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { t, type Locale } from 'i18n';
import { decryptEmail } from '../crypto/email.js';
import { withAccount, type Db } from '../db/client.js';
import { accounts, operators, securityIncidents, securityNotifications } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import type { OutboxHandlers } from './actions.js';
import { enqueueOutbox } from './outbox.js';
import { incidentAccount, publicReason } from './appeals.js';

/** Phase 9 extension point only. No mobile transport is enabled here. */
export interface SecurityPushAdapter { send(accountId: string, notification: { subject: string; body: string; idempotencyKey: string }): Promise<void> }
export function notificationHandlers(_db: Db, deps: { mailer: Mailer; emailKey: Buffer; appOrigin: string; adminOrigin: string }): OutboxHandlers {
  // Operator links must stay on the Tailscale admin origin. Never derive them from request headers.
  const admin = new URL(deps.adminOrigin);
  if (admin.protocol !== 'https:' || !admin.hostname.endsWith('.ts.net') || admin.username || admin.password || admin.port || admin.pathname !== '/' || admin.search || admin.hash) throw new Error('Tailscale admin origin required');
  const handler = (audience: 'owner' | 'operator'): NonNullable<OutboxHandlers['notify_owner']> => async (_payload, row, tx, now) => {
    if (typeof _payload.notificationId === 'string') {
      const [notice] = await tx.select().from(securityNotifications).where(and(eq(securityNotifications.id, _payload.notificationId), eq(securityNotifications.incidentId, row.incidentId), isNull(securityNotifications.mailedAt))).for('update');
      if (!notice) return;
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, notice.accountId));
      const key = createHash('sha256').update(notice.effectKey).digest('hex');
      await deps.mailer.sendMail(decryptEmail(account!.emailEnc, deps.emailKey), notice.subject, notice.body, key);
      await tx.update(securityNotifications).set({ mailedAt: new Date() }).where(eq(securityNotifications.id, notice.id));
      return;
    }
    const [incident] = await tx.select().from(securityIncidents).where(eq(securityIncidents.id, row.incidentId));
    if (!incident) throw new Error('missing incident');
    const owner = audience === 'owner' ? await incidentAccount(tx, incident) : null;
    const ids = audience === 'operator' ? (await tx.select({ id: operators.accountId }).from(operators).where(eq(operators.active, true))).map((o) => o.id) : owner ? [owner] : [];
    if (!ids.length) throw new Error('notification recipient unavailable');
    for (const accountId of ids) {
      const [account] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
      if (!account) continue;
      const locale: Locale = account.locale === 'en' ? 'en' : 'ja';
      const body = audience === 'owner'
        ? `${publicReason(locale)}\n${t(locale, 'security.action')}\n${new URL(`/${locale}/security`, deps.appOrigin).href}`
        : t(locale, 'security.operatorBody', { incidentId: incident.id, url: `${admin.origin}/#security/${incident.id}` });
      const [notice] = await tx.insert(securityNotifications).values({ accountId, incidentId: incident.id, effectKey: `${row.effectKey}:${accountId}`, audience, subject: t(locale, 'security.subject'), body }).onConflictDoNothing().returning();
      if (notice) await enqueueOutbox(tx, { incidentId: incident.id, kind: audience === 'owner' ? 'notify_owner' : 'notify_operator', effectKey: `mail:${notice.effectKey}`, priority: row.priority, now, payload: { notificationId: notice.id } });
    }
  };
  return { notify_owner: handler('owner'), notify_operator: handler('operator') };
}
export async function userNotifications(db: Db, accountId: string) {
  return withAccount(db, accountId, (tx) => tx.select({ id: securityNotifications.id, incidentId: securityNotifications.incidentId, subject: securityNotifications.subject, body: securityNotifications.body })
    .from(securityNotifications).where(and(eq(securityNotifications.accountId, accountId), eq(securityNotifications.audience, 'owner'))).limit(100));
}
