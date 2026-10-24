import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildClientAssets } from '../src/client-build.js';
import { createUploadServer } from '../src/server.js';

describe('ingest network guard', () => {
  it('denies before reading the body or calling ingest (no token consumed, no blob); allowed requests pass; guard failure is 503', async () => {
    const assets = await buildClientAssets();
    let ingested = 0; let mode: 'vpn' | 'unknown' | 'ok' | 'throw' = 'vpn';
    const server = createUploadServer({
      assets, recipientPublicKeyB64: Buffer.alloc(1216, 5).toString('base64'),
      ingest: async () => { ingested++; return { status: 204 }; },
      networkGuard: async () => { if (mode === 'throw') throw new Error('x'); return mode === 'vpn' ? { status: 403, error: 'network_blocked' } : mode === 'unknown' ? { status: 503, error: 'network_unavailable' } : null; },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = () => fetch(`${base}/ingest/id-upload`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/octet-stream' }, body: new Uint8Array(10) });
    try {
      expect((await post()).status).toBe(403);
      mode = 'unknown'; expect((await post()).status).toBe(503);
      mode = 'throw'; expect((await post()).status).toBe(503);
      expect(ingested).toBe(0);
      mode = 'ok'; expect((await post()).status).toBe(204);
      expect(ingested).toBe(1);
    } finally { await new Promise((r) => server.close(r)); }
  });
});
