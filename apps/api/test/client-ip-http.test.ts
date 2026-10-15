import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/http/app.js';
import { parseHops } from '../src/config.js';

// Bad bodies are rejected with 400 after the per-IP limiter, so no db/mailer is touched.
const deps = { db: {}, mailer: {}, config: {}, trustedProxyHops: 0 } as unknown as AppDeps;
const env = (addr: string) => ({ incoming: { socket: { remoteAddress: addr } } });
const post = (app: ReturnType<typeof createApp>, addr: string, xff?: string) =>
  app.request('/auth/recovery/request', { method: 'POST', body: '{}', headers: xff ? { 'x-forwarded-for': xff } : {} }, env(addr));

describe('per-IP limit via socket address', () => {
  it('buckets by socket address and ignores X-Forwarded-For at hops=0', async () => {
    const app = createApp(deps);
    for (let i = 0; i < 10; i++) expect((await post(app, '1.1.1.1', `9.9.9.${i}`)).status).toBe(400);
    expect((await post(app, '1.1.1.1', '8.8.8.8')).status).toBe(429); // spoofed XFF does not escape the bucket
    expect((await post(app, '2.2.2.2')).status).toBe(400); // other socket has its own bucket
  });
});

describe('per-IP limit with one trusted proxy hop', () => {
  it('separates clients by X-Forwarded-For and trusts only the right-most entry', async () => {
    const app = createApp({ ...deps, trustedProxyHops: 1 } as unknown as AppDeps);
    // Same socket (the Next rewrite); different client addresses appended by the proxy get their own buckets.
    for (let i = 0; i < 10; i++) expect((await post(app, '127.0.0.1', `10.0.0.1`)).status).toBe(400);
    expect((await post(app, '127.0.0.1', '10.0.0.1')).status).toBe(429);
    expect((await post(app, '127.0.0.1', '10.0.0.2')).status).toBe(400);
    // A client-supplied left-hand entry cannot escape its bucket: only the proxy-appended right-most entry counts.
    expect((await post(app, '127.0.0.1', '6.6.6.6, 10.0.0.1')).status).toBe(429);
    expect((await post(app, '127.0.0.1', '10.0.0.1, 10.0.0.3')).status).toBe(400); // different right-most entry
  });
});

describe('parseHops', () => {
  it('defaults to 0, accepts 0-10, rejects others', () => {
    expect(parseHops(undefined)).toBe(0);
    expect(parseHops('')).toBe(0);
    expect(parseHops('10')).toBe(10);
    for (const bad of ['11', '-1', 'abc', '1.5']) expect(() => parseHops(bad)).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});
