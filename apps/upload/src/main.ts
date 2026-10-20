import { createPiiPool, handleIdUpload, type IngestToken } from 'platform/pii';
import { buildClientAssets } from './client-build.js';
import { createUploadServer } from './server.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const recipientPublicKeyB64 = required('ID_RECIPIENT_PUBLIC_KEY');
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3001';
const ingestSecret = required('INGEST_SHARED_SECRET');
// Only the append-only ingest role: it cannot read anything back.
const sql = createPiiPool(required('PII_INGEST_DATABASE_URL'), { max: 5 });

async function consumeToken(token: string): Promise<IngestToken | null> {
  const res = await fetch(new URL('/internal/verification/consume-token', apiOrigin), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ingest-secret': ingestSecret }, body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`consume-token failed: ${res.status}`);
  const b = await res.json() as { uploadId: string; accountId: string; expiresAt: string };
  return { uploadId: b.uploadId, accountId: b.accountId, expiresAt: new Date(b.expiresAt) };
}

const server = createUploadServer({
  assets: await buildClientAssets(),
  recipientPublicKeyB64,
  // The log line carries the event, status and size only.
  ingest: (input) => handleIdUpload({ sql, consumeToken, log: (e) => console.log(JSON.stringify(e)) }, input),
});
const port = Number(process.env.UPLOAD_PORT ?? 5174);
server.listen(port, process.env.UPLOAD_HOST ?? '127.0.0.1', () => console.log(`upload listening on :${port}`));
