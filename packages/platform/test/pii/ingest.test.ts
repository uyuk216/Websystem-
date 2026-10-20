import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleIdUpload, MAX_INGEST_BYTES, type IngestToken } from '../../src/pii/ingest.js';
import { withPiiTestDb } from './helpers.js';

const envelope = (n = 200): Uint8Array => {
  const b = new Uint8Array(1 + 32 + 1088 + 12 + n);
  b[0] = 1;
  b.fill(7, 1);
  return b;
};
const octet = 'application/octet-stream';

describe('ID upload intake (pii_ingest)', () => {
  it('appends the ciphertext under the ids bound to the token, ignoring everything else in the request', () =>
    withPiiTestDb(async ({ ingest, admin }) => {
      const t: IngestToken = { uploadId: randomUUID(), accountId: randomUUID(), expiresAt: new Date(Date.now() + 7 * 86_400_000) };
      const logs: unknown[] = [];
      const body = envelope();
      const r = await handleIdUpload({ sql: ingest, consumeToken: async () => t, log: (e) => logs.push(e) }, { token: 'tok', contentType: octet, body });
      expect(r.status).toBe(204);
      const rows = await admin`SELECT upload_id, account_id, size_bytes, ciphertext, expires_at FROM student_id_blobs`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ upload_id: t.uploadId, account_id: t.accountId, size_bytes: body.length });
      expect(Buffer.from(rows[0]!.ciphertext).equals(Buffer.from(body))).toBe(true);
      // The log holds the event, status and size only: no token, no ids, no content.
      expect(logs).toEqual([{ event: 'id-upload', status: 204, size: body.length }]);
    }));

  it('rejects a missing token, a wrong type, oversize and malformed bodies before consuming the token', () =>
    withPiiTestDb(async ({ ingest, admin }) => {
      let consumed = 0;
      const deps = { sql: ingest, consumeToken: async () => { consumed++; return null; } };
      expect((await handleIdUpload(deps, { token: null, contentType: octet, body: envelope() })).status).toBe(401);
      expect((await handleIdUpload(deps, { token: 't', contentType: 'image/jpeg', body: envelope() })).status).toBe(415);
      expect((await handleIdUpload(deps, { token: 't', contentType: 'multipart/form-data', body: envelope() })).status).toBe(415);
      expect((await handleIdUpload(deps, { token: 't', contentType: octet, body: new Uint8Array(MAX_INGEST_BYTES + 1) })).status).toBe(413);
      expect((await handleIdUpload(deps, { token: 't', contentType: octet, body: new Uint8Array(50) })).status).toBe(400);
      const wrongVersion = envelope();
      wrongVersion[0] = 9;
      expect((await handleIdUpload(deps, { token: 't', contentType: octet, body: wrongVersion })).status).toBe(400);
      expect(consumed).toBe(0);
      // An expired / used / unknown token is refused and nothing is stored.
      expect((await handleIdUpload(deps, { token: 't', contentType: octet, body: envelope() })).status).toBe(401);
      expect(consumed).toBe(1);
      expect(await admin`SELECT 1 FROM student_id_blobs`).toHaveLength(0);
    }));

  it('cannot write the same upload twice and reports an unreachable token service as 503', () =>
    withPiiTestDb(async ({ ingest, admin }) => {
      const t: IngestToken = { uploadId: randomUUID(), accountId: randomUUID(), expiresAt: new Date(Date.now() + 1e6) };
      const deps = { sql: ingest, consumeToken: async () => t };
      expect((await handleIdUpload(deps, { token: 'a', contentType: octet, body: envelope() })).status).toBe(204);
      expect((await handleIdUpload(deps, { token: 'b', contentType: octet, body: envelope(300) })).status).toBe(409);
      expect(await admin`SELECT 1 FROM student_id_blobs`).toHaveLength(1);
      const down = { sql: ingest, consumeToken: async (): Promise<IngestToken | null> => { throw new Error('ECONNREFUSED'); } };
      expect((await handleIdUpload(down, { token: 'a', contentType: octet, body: envelope() })).status).toBe(503);
    }));
});
