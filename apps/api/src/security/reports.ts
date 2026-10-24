import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { UUID_RE } from 'shared';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { apps } from '../db/schema.js';
import { handleSecuritySignal } from './incidents.js';
import { buildSignal } from './signals.js';
export async function submitReport(db: Db, reporter: string, body: unknown, now = new Date()): Promise<'ok' | 'invalid' | 'not_found' | 'rate_limited'> {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.appId !== 'string' || !UUID_RE.test(b.appId) || !['phishing', 'malware', 'abuse'].includes(String(b.category)) || (b.message !== undefined && (typeof b.message !== 'string' || b.message.length > 2000))) return 'invalid';
  await withAccount(db, reporter, async () => {}); // authenticated identity comes exclusively from the session
  return withSystem(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`report:${reporter}`}, 0))`);
    const [app] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, b.appId as string));
    if (!app) return 'not_found';
    const prefix = `report:${reporter}:${now.toISOString().slice(0,10)}:`;
    const [count] = await tx.execute<{ count: string }>(sql`select count(*)::text as count from security_incidents where source = 'manual' and source_event_id like ${`${prefix}%`}`);
    if (Number(count?.count) >= 5) return 'rate_limited';
    await handleSecuritySignal(tx as unknown as Db, buildSignal({ source: 'manual', sourceEventId: `${prefix}${randomUUID()}`, ruleVersion: '1', occurredAt: now, severity: 'low', target: { kind: 'app', appId: app.id }, reasonCode: 'community_report', evidence: { category: String(b.category) } }));
    return 'ok';
  });
}
