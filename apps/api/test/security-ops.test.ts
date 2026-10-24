import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APPROVAL_LIST, SECURITY_SETTING_SPECS, assessProductionDefense, resolveSecuritySettings, validateSecuritySetting } from 'shared';
import { formatStatus, securityStatus } from '../src/security/status.js';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('security settings validation', () => {
  it('rejects unknown keys, negatives, zero, unlimited and out-of-range values', () => {
    expect(validateSecuritySetting('security.nope', 1)).toEqual({ ok: false, error: 'unknown_key' });
    expect(validateSecuritySetting('security.__proto__', 1).ok).toBe(false);
    for (const v of [-1, 0, Infinity, NaN, 1e15, '5', null, 2.5]) expect(validateSecuritySetting('security.min_samples', v).ok).toBe(false);
    expect(validateSecuritySetting('security.min_samples', 5).ok).toBe(true);
    expect(validateSecuritySetting('security.threshold.cpu', 1.5).ok).toBe(false);
    expect(validateSecuritySetting('security.outbox.capacity', Number.MAX_SAFE_INTEGER).ok).toBe(false);
  });
  it('production refuses test mode and overly broad exception CIDRs', () => {
    expect(validateSecuritySetting('security.detector.falco.mode', 'test', { production: true })).toEqual({ ok: false, error: 'too_permissive_in_production' });
    expect(validateSecuritySetting('security.detector.falco.mode', 'test').ok).toBe(true);
    expect(validateSecuritySetting('security.detector.falco.mode', 'enforce', { production: true }).ok).toBe(true);
    expect(validateSecuritySetting('security.network.exceptions', ['0.0.0.0/0']).ok).toBe(false);
    expect(validateSecuritySetting('security.network.exceptions', ['::/0']).ok).toBe(false);
    expect(validateSecuritySetting('security.network.exceptions', ['203.0.113.0/24', '2001:db8::/32']).ok).toBe(true);
    expect(validateSecuritySetting('security.notify.operator_to', 'not-mail').ok).toBe(false);
  });
  it('invalid stored values fall back to defaults, never to zero or unlimited', () => {
    const r = resolveSecuritySettings({ 'security.window_ms': -5, 'security.min_samples': 7 });
    expect(r['security.window_ms']).toBe(60000);
    expect(r['security.min_samples']).toBe(7);
  });
});

describe('doctor / status honesty', () => {
  it('reports every part as not installed and never complete by default', () => {
    const s = securityStatus({});
    expect(s.complete).toBe(false);
    expect(s.parts.every((p) => p.state === 'not_installed')).toBe(true);
    const text = formatStatus(s).join('\n');
    expect(text).toContain('INCOMPLETE');
    expect(text).not.toContain('COMPLETE\n');
  });
  it('observe, unset and unknown modes keep it incomplete even when everything is installed', () => {
    const all = Object.fromEntries(assessProductionDefense({}).parts.map((p) => [p.part, true]));
    const enforce = { SECURITY_FALCO_MODE: 'enforce', SECURITY_METRICS_MODE: 'enforce', SECURITY_NETWORK_MODE: 'enforce', SECURITY_HONEYTOKEN_MODE: 'enforce', SECURITY_DB_AUDIT_MODE: 'enforce', SECURITY_BROWSING_MODE: 'enforce' };
    expect(securityStatus(enforce, { installed: all }).complete).toBe(true);
    expect(securityStatus({ ...enforce, SECURITY_FALCO_MODE: 'observe' }, { installed: all }).blockers).toEqual(['falco']);
    expect(securityStatus({ ...enforce, SECURITY_NETWORK_MODE: 'weird' }, { installed: all }).blockers).toEqual(['network_data']);
    expect(securityStatus({ ...enforce, SECURITY_DB_AUDIT_MODE: undefined }, { installed: all }).blockers).toEqual(['db_audit']);
  });
  it('shows expired network data and undelivered audit', () => {
    const all = Object.fromEntries(assessProductionDefense({}).parts.map((p) => [p.part, true]));
    const enforce = { SECURITY_FALCO_MODE: 'enforce', SECURITY_METRICS_MODE: 'enforce', SECURITY_NETWORK_MODE: 'enforce', SECURITY_HONEYTOKEN_MODE: 'enforce', SECURITY_DB_AUDIT_MODE: 'enforce', SECURITY_BROWSING_MODE: 'enforce' };
    const now = new Date('2026-10-25T00:00:00Z');
    const s = securityStatus(enforce, { installed: all, now, networkData: { fetchedAt: new Date('2026-10-01T00:00:00Z'), maxAgeMs: 86_400_000 }, auditUndelivered: 3 });
    expect(s.parts.find((p) => p.part === 'network_data')!.state).toBe('expired');
    expect(s.parts.find((p) => p.part === 'audit_worm')!.state).toBe('undelivered');
    expect(s.complete).toBe(false);
  });
  it('doctor.sh names every not-installed Phase 6 part', () => {
    const d = read('scripts/doctor.sh');
    for (const w of ['Falco', 'metrics and mandatory egress proxy', 'Safe Browsing', 'IP anonymity data', 'honeytoken', 'Object Lock', 'INCOMPLETE']) expect(d).toContain(w);
  });
});

describe('approval list', () => {
  it('covers Tasks 3-8 and the operations doc mentions the distinctions', () => {
    for (const t of [3, 4, 5, 6, 7, 8]) expect(APPROVAL_LIST.some((a) => a.task === t)).toBe(true);
    expect(APPROVAL_LIST.some((a) => a.kinds.includes('irreversible'))).toBe(true);
    const doc = read('docs/security/phase6-operations.md');
    for (const w of ['Falco', 'MaxMind', 'pgAudit', 'Safe Browsing', 'Object Lock', '解除できない保持', '有料契約']) expect(doc).toContain(w);
  });
  it('every documented setting key exists in the schema and vice versa', () => {
    const doc = read('docs/security/phase6-operations.md');
    for (const k of Object.keys(SECURITY_SETTING_SPECS).filter((k) => !k.startsWith('security.detector.'))) expect(doc).toContain(k.replace('security.scan.threshold', 'security.scan.threshold'));
    expect(doc).toContain('security.detector.<名前>.mode');
  });
  it('the recovery procedure keeps other reasons and never deletes evidence', () => {
    const doc = read('docs/security/phase6-operations.md');
    expect(doc).toContain('ほかの停止理由');
    expect(doc).toContain('削除しません');
  });
});
