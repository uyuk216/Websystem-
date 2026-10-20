import { describe, expect, it } from 'vitest';
import { FakeProvider, ManualProvider, type VerificationProvider } from '../src/index.js';

const input = { verificationId: 'v1', accountId: 'a1', uploadId: 'u1' };

describe.each([['ManualProvider', () => new ManualProvider()], ['FakeProvider', () => new FakeProvider()]] as const)('%s', (_n, make) => {
  it('queues submissions and applies one decision per ref', async () => {
    const p: VerificationProvider & ManualProvider = make();
    const { ref } = await p.submit(input);
    expect(await p.status(ref)).toBe('pending');
    expect(p.pending()).toEqual([{ ref, input }]);
    await p.decide(ref, { result: 'rejected', reason: 'blurry' });
    expect(await p.status(ref)).toBe('rejected');
    expect(p.pending()).toEqual([]);
    await expect(p.decide(ref, { result: 'approved' })).rejects.toThrow();
    expect(await p.status('nope')).toBe('unknown');
    await expect(p.decide('nope', { result: 'approved' })).rejects.toThrow();
  });
});

it('FakeProvider records decisions so a swap in tests can be asserted', async () => {
  const p = new FakeProvider();
  const { ref } = await p.submit(input);
  await p.decide(ref, { result: 'approved' });
  expect(p.decisions).toEqual([{ ref, decision: { result: 'approved' } }]);
});
