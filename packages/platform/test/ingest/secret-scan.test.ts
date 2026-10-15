import { describe, expect, it } from 'vitest';
import { scanSecrets } from '../../src/ingest/secret-scan.js';

const scan = (s: string) => scanSecrets('f.js', Buffer.from(s));
const A = 'A'.repeat(36);

describe('scanSecrets', () => {
  it.each([
    ['aws_access_key', 'k = "AKIAABCDEFGHIJKLMNOP"', 'AKIAabc'],
    ['github_token', `t = "ghp_${A}"`, 'ghp_short'],
    ['stripe_key', 'sk_live_abcdefghijklmnop', 'sk_live_short'],
    ['slack_token', 'xoxb-123-456', 'xoxz-123'],
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PUBLIC KEY-----'],
    ['google_api_key', `AIza${'a'.repeat(35)}`, `AIza${'a'.repeat(10)}`],
    ['env_secret', 'API_KEY=abcdefgh1234', 'PASSWORD=short'],
  ])('%s detected and not false-positive', (rule, bad, ok) => {
    expect(scan(bad)).toEqual([{ path: 'f.js', line: 1, rule }]);
    expect(scan(ok)).toEqual([]);
  });
  it('reports line numbers and never the value', () => {
    const r = scan('ok\nTOKEN = supersecretvalue\n');
    expect(r).toEqual([{ path: 'f.js', line: 2, rule: 'env_secret' }]);
    expect(JSON.stringify(r)).not.toContain('supersecret');
  });
  it('skips binary (NUL) and files over 2MB', () => {
    expect(scanSecrets('a', Buffer.concat([Buffer.from('AKIAABCDEFGHIJKLMNOP'), Buffer.from([0])]))).toEqual([]);
    expect(scanSecrets('a', Buffer.from('AKIAABCDEFGHIJKLMNOP'.padEnd(2 * 1024 * 1024 + 1, ' ')))).toEqual([]);
  });
});
