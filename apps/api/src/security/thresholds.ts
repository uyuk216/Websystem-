import { and, eq, gte, isNull, lte } from 'drizzle-orm';
import { grants } from '../db/schema.js';
import { withSystem } from '../db/client.js';
import { resolveEntitlements } from '../grants/entitlements.js';
import type { Db } from '../db/client.js';
export interface Thresholds { windowMs: number; minSamples: number; maxGapMs: number; cpu: number; egressBytes: number; connections: number; servedBytes: number }
export const DEFAULT_THRESHOLDS: Thresholds = { windowMs: 60000, minSamples: 3, maxGapMs: 30000, cpu: 0.8, egressBytes: 104857600, connections: 1000, servedBytes: 104857600 };
export function validateThresholds(t: Thresholds): void {
  if (Object.values(t).some(v => !Number.isFinite(v) || v <= 0) || !Number.isInteger(t.minSamples) || t.minSamples < 2 || t.cpu > 1 || t.maxGapMs > t.windowMs) throw new Error('invalid_thresholds');
}
/** Only the served-byte threshold changes; active grants/params are resolved by the canonical entitlement function. */
export async function thresholdsFor(db: Db, ownerId: string, appId: string, at: Date, base = DEFAULT_THRESHOLDS): Promise<Thresholds> {
  validateThresholds(base);
  const effective = await resolveEntitlements(db, ownerId, at, { appId });
  if (effective.plan === 'none') return { ...base };
  const active = await withSystem(db, tx => tx.select({ params: grants.params }).from(grants).where(and(eq(grants.targetKind, 'app'), eq(grants.targetId, appId), eq(grants.kind, 'event_boost'), isNull(grants.revokedAt), lte(grants.startsAt, at), gte(grants.endsAt, at))));
  const ratio = Math.max(1, ...active.map(g => { const v = (g.params as Record<string, unknown> | null)?.anomalyThresholdMultiplier; return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100 ? v : 1; }));
  return { ...base, servedBytes: base.servedBytes * ratio };
}
