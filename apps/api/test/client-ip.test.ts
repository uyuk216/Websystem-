import { describe, expect, it } from 'vitest';
import { resolveClientIp } from '../src/http/app.js';

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For with 0 hops', () => {
    expect(resolveClientIp('6.6.6.6', '1.2.3.4', 0)).toBe('1.2.3.4');
    expect(resolveClientIp('6.6.6.6', undefined, 0)).toBe('unknown');
  });
  it('takes the Nth entry from the right with trusted hops', () => {
    expect(resolveClientIp('6.6.6.6, 9.9.9.9', '10.0.0.1', 1)).toBe('9.9.9.9');
    expect(resolveClientIp('6.6.6.6, 9.9.9.9', '10.0.0.1', 2)).toBe('6.6.6.6');
    expect(resolveClientIp('9.9.9.9', '10.0.0.1', 3)).toBe('10.0.0.1');
    expect(resolveClientIp(undefined, '10.0.0.1', 1)).toBe('10.0.0.1');
  });
});
