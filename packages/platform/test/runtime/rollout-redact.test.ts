import { describe, expect, it } from 'vitest';
import { collectLogs } from '../../src/runtime/rollout.js';
import type { RuntimeDriver } from '../../src/runtime/driver.js';

const A = '11111111-1111-1111-1111-111111111111';
const fake = (lines: string[]) => ({ logs: async () => lines }) as unknown as RuntimeDriver;
const run = (lines: string[], secrets: string[]) => collectLogs(fake(lines), A, A, secrets);

describe('collectLogs redaction', () => {
  it('redacts overlapping secrets, longest first', async () => {
    const [l] = await run(['x supersecret-long y'], ['supersecret', 'supersecret-long']);
    expect(l).toBe('x *** y');
  });
  it('redacts a secret that straddles the 2000 char cut', async () => {
    const [l] = await run(['a'.repeat(1990) + 'topsecretvalue'], ['topsecretvalue']);
    expect(l).not.toContain('topsecret');
    expect(l).not.toContain('value');
  });
  it('redacts each line of a multi-line (PEM) value', async () => {
    const pem = '-----BEGIN KEY-----\nMIIEvQIBADANBgkq\n-----END KEY-----';
    const out = await run(['MIIEvQIBADANBgkq', '-----BEGIN KEY-----', 'ok'], [pem]);
    expect(out).toEqual(['***', '***', 'ok']);
  });
  it('redacts base64 and url-encoded forms', async () => {
    const v = 'p@ss w0rd/&=';
    const out = await run([Buffer.from(v).toString('base64'), encodeURIComponent(v), `x=${v}`], [v]);
    expect(out.join('\n')).not.toMatch(/p@ss|cEBzcy|p%40ss/);
  });
  it('ignores trivial values', async () => {
    expect(await run(['abc'], ['abc'])).toEqual(['abc']);
  });
});
