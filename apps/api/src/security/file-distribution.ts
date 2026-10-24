import { createHmac } from 'node:crypto';
export interface DistributionConfig { windowMs: number; bytes: number; concentration: number; externalRatio: number; minRequests: number }
export const DISTRIBUTION_DEFAULTS: DistributionConfig = { windowMs: 600000, bytes: 100 * 1024 ** 2, concentration: 0.8, externalRatio: 0.5, minRequests: 2 };
export interface DistributionSample { appId: string; path: string; bytes: number; referrer: string | null; origin: string; at: number }
export interface DistributionStore { append(row: { appId: string; day: string; fileHash: string; bytes: number; external: boolean; at: number }): Promise<void>; window(appId: string, since: number): Promise<Array<{ fileHash: string; bytes: number; external: boolean }>>; prune(before: number): Promise<void> }
export class FileDistributionDetector {
  constructor(private key: Buffer, private store: DistributionStore, private config: DistributionConfig = DISTRIBUTION_DEFAULTS) {
    if (key.length < 32 || !Number.isFinite(config.windowMs) || config.windowMs <= 0 || config.windowMs > 86400000 || !Number.isFinite(config.bytes) || config.bytes <= 0 || !Number.isInteger(config.minRequests) || config.minRequests < 2 || [config.concentration, config.externalRatio].some(v => !Number.isFinite(v) || v <= 0 || v > 1)) throw new Error('invalid_distribution_config');
  }
  async record(s: DistributionSample): Promise<boolean> {
    if (!Number.isSafeInteger(s.bytes) || s.bytes <= 0 || !Number.isFinite(s.at)) return false;
    const path = new URL(s.path, 'https://path.invalid').pathname;
    const day = new Date(s.at).toISOString().slice(0,10);
    const fileHash = createHmac('sha256', this.key).update(`${day}:${s.appId}:${path}`).digest('hex');
    let external = false;
    try { external = !!s.referrer && new URL(s.referrer).origin !== new URL(s.origin).origin; } catch { /* missing/invalid is not evidence */ }
    await this.store.prune(s.at - 30 * 86400000);
    await this.store.append({ appId: s.appId, day, fileHash, bytes: s.bytes, external, at: s.at });
    const rows = await this.store.window(s.appId, s.at - this.config.windowMs);
    if (rows.length < this.config.minRequests) return false;
    let total = 0, outside = 0; const files = new Map<string, number>();
    for (const row of rows) { total += row.bytes; if (row.external) outside += row.bytes; files.set(row.fileHash, (files.get(row.fileHash) ?? 0) + row.bytes); }
    return total >= this.config.bytes && Math.max(...files.values()) / total >= this.config.concentration && outside / total >= this.config.externalRatio;
  }
}

import { sql } from 'drizzle-orm';
import { withSystem, type Db } from '../db/client.js';
import { handleSecuritySignal } from './incidents.js';
import { buildSignal } from './signals.js';
/** Durable observer: evidence and signal/outboxes commit together; no access-log buffering/drop path. */
export function createDistributionObserver(db: Db, key: Buffer, config = DISTRIBUTION_DEFAULTS): { record(s: DistributionSample): Promise<void> } {
  return { async record(s) { await withSystem(db, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`distribution:${s.appId}`}, 0))`);
    const store: DistributionStore = {
      append: async r => { await tx.execute(sql`insert into security_distribution_samples(app_id, day, file_hash, bytes, external, observed_at) values (${r.appId}, ${r.day}, ${r.fileHash}, ${r.bytes}, ${r.external}, ${new Date(r.at).toISOString()})`); },
      window: async (appId, since) => { const rows = await tx.execute<{ file_hash: string; bytes: string; external: boolean }>(sql`select file_hash, bytes::text, external from security_distribution_samples where app_id=${appId} and observed_at >= ${new Date(since).toISOString()} and observed_at <= ${new Date(s.at).toISOString()}`); return rows.map(r => ({ fileHash: r.file_hash, bytes: Number(r.bytes), external: r.external })); },
      prune: async before => { await tx.execute(sql`delete from security_distribution_samples where observed_at < ${new Date(before).toISOString()}`); },
    };
    if (await new FileDistributionDetector(key, store, config).record(s)) await handleSecuritySignal(tx as unknown as Db, buildSignal({ source: 'file_distribution', sourceEventId: `${s.appId}:${Math.floor(s.at / config.windowMs)}`, ruleVersion: '1', occurredAt: new Date(s.at), severity: 'medium', target: { kind: 'app', appId: s.appId }, reasonCode: 'file_distribution.concentrated', evidence: { windowSeconds: config.windowMs / 1000, threshold: config.bytes } }));
  }); } };
}
