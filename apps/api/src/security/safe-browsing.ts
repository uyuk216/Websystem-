import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apps } from '../db/schema.js';
import { withSystem, type Db } from '../db/client.js';
import { handleSecuritySignal } from './incidents.js';
import { buildSignal } from './signals.js';
export type BrowsingVerdict = 'unlisted' | 'malicious' | 'pending';
export interface SafeBrowsingClient { installed: boolean; check(publicUrl: string, signal: AbortSignal): Promise<BrowsingVerdict> }
export interface PublicationPolicy { installed: boolean; check(appId: string): Promise<'allow' | 'malicious' | 'pending'> }
export const unavailablePublication: PublicationPolicy = { installed: false, check: async () => 'pending' };
/** Resolve only platform-owned tenant origins. No caller URL, query, internal/ID-upload origin or key is accepted. */
export function createPublicationPolicy(db: Db, client: SafeBrowsingClient, tenantDomain: string, timeoutMs = 5000): PublicationPolicy {
  if (!/^[a-z0-9.-]+$/.test(tenantDomain) || tenantDomain === 'localhost' || !tenantDomain.includes('.') || /^\d/.test(tenantDomain)) throw new Error('invalid_public_domain');
  return { installed: client.installed, async check(appId) {
    if (!client.installed) return 'pending';
    const [app] = await withSystem(db, tx => tx.select({ name: apps.name }).from(apps).where(eq(apps.id, appId)));
    if (!app || !/^[a-z0-9-]+$/.test(app.name)) return 'pending';
    const url = `https://${app.name}.${tenantDomain}/`;
    const controller = new AbortController(); let timer: NodeJS.Timeout | undefined;
    let verdict: BrowsingVerdict;
    try {
      verdict = await Promise.race([client.check(url, controller.signal), new Promise<'pending'>(resolve => { timer = setTimeout(() => { controller.abort(); resolve('pending'); }, timeoutMs); })]);
    } catch { verdict = 'pending'; } finally { clearTimeout(timer); }
    if (verdict === 'malicious') {
      const urlHash = createHash('sha256').update(url).digest('hex');
      await handleSecuritySignal(db, buildSignal({ source: 'phishing', sourceEventId: `${appId}:${urlHash.slice(0,32)}`, ruleVersion: '1', occurredAt: new Date(), severity: 'high', target: { kind: 'app', appId }, reasonCode: 'phishing.public_url', evidence: { urlHash, verdict: 'malicious' } }));
      return 'malicious';
    }
    // Unlisted is a point-in-time provider result, never a guarantee of safety.
    return verdict === 'unlisted' ? 'allow' : 'pending';
  } };
}
