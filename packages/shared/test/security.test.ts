import { describe, expect, it } from 'vitest';
import { canonicalEvidence, planFor, validateSignalShape, type SecuritySignal } from '../src/security.js';

const signal = (): SecuritySignal => ({ source: 'falco', sourceEventId: 'event-1', ruleVersion: '1', occurredAt: new Date(), severity: 'high', target: { kind: 'app', appId: 'aaaaaaaa-0000-4000-8000-000000000001' }, reasonCode: 'falco.shell', evidence: { rule: 'shell', count: 1 }, evidenceDigest: 'a'.repeat(64) });
describe('security signal contract', () => {
  it('only app targets receive container stops; lower severities never stop', () => {
    for (const target of ['app', 'account', 'ip'] as const) {
      expect(planFor('low', target)).toEqual({ block: false, stopContainer: false, notifyOperator: true });
      expect(planFor('medium', target)).toEqual({ block: true, stopContainer: false, notifyOperator: true });
      expect(planFor('high', target).stopContainer).toBe(target === 'app');
    }
  });
  it('rejects secret-bearing keys, invalid digests and unbounded evidence', () => {
    expect(validateSignalShape(signal())).toBeNull();
    expect(validateSignalShape({ ...signal(), evidence: { password: 'secret' } })).toBe('bad_evidence_key');
    expect(validateSignalShape({ ...signal(), evidence: { value: Infinity } })).toBe('bad_evidence_value');
    expect(validateSignalShape({ ...signal(), evidenceDigest: 'x' })).toBe('bad_digest');
    expect(validateSignalShape({ ...signal(), evidence: { rule: 'x'.repeat(129) } })).toBe('bad_evidence_value');
  });
  it('canonicalizes evidence independently of key insertion order', () => {
    expect(canonicalEvidence({ count: 1, rule: 'shell' })).toBe(canonicalEvidence({ rule: 'shell', count: 1 }));
  });
});
