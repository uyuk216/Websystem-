import { describe, expect, it } from 'vitest';
import { FalcoAdapter, MemoryReplayStore, signFalco } from '../../src/security/falco.js';
const now = 1792800000000;
const key = Buffer.alloc(32, 7);
function fixture() {
  const adapter = new FalcoAdapter({ key, now: () => now, mode: 'observe', replay: new MemoryReplayStore(), resolver: { resolve: async i => i.namespace === 'tenants' && i.podUid === 'current' && i.containerId === 'container' && i.deployment === 'deployment' ? { appId: 'app' } : null } });
  const send = (v: unknown, nonce = 'nonce123456789012') => { const body = JSON.stringify(v); const timestamp = String(now); return adapter.receive(body, { timestamp, nonce, signature: signFalco(key, timestamp, nonce, body) }); };
  return { adapter, send };
}
const event = { eventId: 'one', rule: 'tenant_escape', time: new Date(now).toISOString(), workload: { namespace: 'tenants', podUid: 'current', containerId: 'container', deployment: 'deployment' }, output: 'DO NOT STORE secret' };
describe('authenticated Falco adapter', () => {
  it('starts not installed; strips raw output and ignores claimed app', async () => { const f = fixture(); expect(f.adapter.status().installed).toBe(false); const result = await f.send({ ...event, appId: 'victim' }); expect(result?.appId).toBe('app'); expect(JSON.stringify(result)).not.toContain('secret'); });
  it('rejects replay and foreign/stale workloads', async () => { const f = fixture(); await f.send(event); await expect(f.send(event)).rejects.toThrow('replay'); await expect(fixture().send({ ...event, workload: { ...event.workload, podUid: 'old' } })).rejects.toThrow('untrusted_workload'); });
  it('rejects signature, size and malformed time', async () => { const f = fixture(); await expect(f.adapter.receive('{}', { timestamp: String(now), nonce: 'nonce123456789012', signature: '0'.repeat(64) })).rejects.toThrow('authentication'); await expect(f.send({ ...event, time: 'bad' })).rejects.toThrow('malformed'); await expect(fixture().send({ output: 'a'.repeat(65537) })).rejects.toThrow('body_limit'); });
  it('reports missing/drop/unknown signals without treating them as attacks', async () => { const f = fixture(); expect(await f.send({ type: 'heartbeat', dropped: 4 })).toBeNull(); await f.send({ rule: 'unknown' }, 'other123456789012'); expect(f.adapter.status()).toMatchObject({ dropped: 4, unknownRules: 1, lastSeen: now }); });
});
