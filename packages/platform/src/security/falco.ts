import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SensorStatus, WorkloadIdentity, WorkloadResolver } from './telemetry.js';
export const FALCO_RULES = { tenant_mining: 'high', tenant_escape: 'high' } as const;
export interface FalcoEvent { eventId: string; rule: keyof typeof FALCO_RULES; appId: string; occurredAt: Date }
export interface ReplayStore { claim(nonce: string, expires: number, now: number): Promise<boolean> }
/** Fixture/single-process implementation; production collectors require a shared atomic store. */
export class MemoryReplayStore implements ReplayStore {
  private seen = new Map<string, number>();
  async claim(nonce: string, expires: number, now: number): Promise<boolean> {
    for (const [k, until] of this.seen) if (until < now) this.seen.delete(k);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expires); return true;
  }
}
export function signFalco(key: Buffer, timestamp: string, nonce: string, body: string): string {
  return createHmac('sha256', key).update(`${timestamp}\n${nonce}\n${body}`).digest('hex');
}
export class FalcoAdapter {
  private health: SensorStatus = { installed: false, mode: 'disabled', lastSeen: null, dropped: 0, unknownRules: 0 };
  constructor(private deps: { key: Buffer; resolver: WorkloadResolver; replay: ReplayStore; now: () => number; mode: 'observe' | 'enforce' }) {
    if (deps.key.length < 32) throw new Error('collector key too short');
    this.health.mode = deps.mode;
  }
  status(): SensorStatus { return { ...this.health }; }
  async receive(body: string, headers: { timestamp: string; nonce: string; signature: string }): Promise<FalcoEvent | null> {
    const now = this.deps.now();
    if (Buffer.byteLength(body) > 65536) throw new Error('body_limit');
    if (!/^\d{13}$/.test(headers.timestamp) || Math.abs(now - Number(headers.timestamp)) > 60000 || !/^[a-zA-Z0-9_-]{16,128}$/.test(headers.nonce)) throw new Error('authentication');
    const expected = signFalco(this.deps.key, headers.timestamp, headers.nonce, body);
    if (!/^[a-f0-9]{64}$/.test(headers.signature) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(headers.signature, 'hex'))) throw new Error('authentication');
    if (!await this.deps.replay.claim(headers.nonce, now + 60000, now)) throw new Error('replay');
    const v = JSON.parse(body) as Record<string, unknown>;
    if (typeof v !== 'object' || !v) throw new Error('malformed');
    if (v.type === 'heartbeat') {
      if (!Number.isSafeInteger(v.dropped) || Number(v.dropped) < 0) throw new Error('malformed');
      this.health.dropped = Number(v.dropped); this.health.lastSeen = now; this.health.installed = true; return null;
    }
    if (typeof v.rule !== 'string' || !Object.hasOwn(FALCO_RULES, v.rule)) { this.health.unknownRules++; return null; }
    if (typeof v.eventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(v.eventId) || typeof v.time !== 'string' || !Number.isFinite(Date.parse(v.time)) || Math.abs(now - Date.parse(v.time)) > 60000) throw new Error('malformed');
    const identity = v.workload as WorkloadIdentity | undefined;
    if (!identity || ['containerId', 'podUid', 'namespace', 'deployment'].some(k => typeof (identity as unknown as Record<string, unknown>)[k] !== 'string' || !(identity as unknown as Record<string, unknown>)[k])) throw new Error('identity');
    const resolved = await this.deps.resolver.resolve(identity);
    if (!resolved) throw new Error('untrusted_workload');
    this.health.lastSeen = now; this.health.installed = true;
    return { eventId: v.eventId, rule: v.rule as keyof typeof FALCO_RULES, appId: resolved.appId, occurredAt: new Date(v.time) };
  }
}
