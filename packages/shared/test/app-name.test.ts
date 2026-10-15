import { describe, expect, it } from 'vitest';
import { RESERVED_APP_NAMES, STATIC_LIMITS, validateAppName } from '../src/index.js';

describe('validateAppName', () => {
  it.each(['a-b', 'abc', 'my-site-1', '123', 'a'.repeat(32)])('accepts %s', (n) => {
    expect(validateAppName(n)).toEqual({ ok: true });
  });
  it.each(['ab', '-ab', 'ab-', 'a--b', 'ABC', 'a'.repeat(33), '', 'a_b', 'a.b', 'あいう', 'a b'])('rejects %j as format', (n) => {
    expect(validateAppName(n)).toEqual({ ok: false, reason: 'format' });
  });
  it('rejects reserved names', () => {
    for (const n of ['www', 'admin', 'api', 'login', 'github', 'paypal', 'stripe', 'line']) {
      expect(validateAppName(n)).toEqual({ ok: false, reason: 'reserved' });
    }
  });
  it('has 50+ reserved entries, all themselves well-formed lowercase', () => {
    expect(RESERVED_APP_NAMES.size).toBeGreaterThanOrEqual(50);
    for (const n of RESERVED_APP_NAMES) expect(n).toBe(n.toLowerCase());
  });
  it('limits', () => {
    expect(STATIC_LIMITS).toEqual({ storageBytes: 200 * 1024 ** 2, fileBytes: 25 * 1024 ** 2, monthlyTransferBytes: 10 * 1024 ** 3, sitesPerOwner: 1 });
  });
});
