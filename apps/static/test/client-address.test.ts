import { describe, expect, it } from 'vitest';
import { clientAddress } from '../src/proxy.js';

describe('clientAddress', () => {
  it('ignores X-Forwarded-For when no proxy is trusted (a visitor cannot pick their own address)', () => {
    expect(clientAddress('203.0.113.9', '10.0.0.5', 0)).toBe('10.0.0.5');
  });
  it('with one trusted proxy takes the entry that proxy appended (the rightmost)', () => {
    expect(clientAddress('6.6.6.6, 203.0.113.9', '10.42.2.7', 1)).toBe('203.0.113.9');
    expect(clientAddress(['6.6.6.6', '203.0.113.9'], '10.42.2.7', 1)).toBe('203.0.113.9');
  });
  it('falls back to the socket address when the header is missing or too short', () => {
    expect(clientAddress(undefined, '10.42.2.7', 1)).toBe('10.42.2.7');
    expect(clientAddress('203.0.113.9', '10.42.2.7', 2)).toBe('10.42.2.7');
    expect(clientAddress(undefined, undefined, 0)).toBe('');
  });
});
