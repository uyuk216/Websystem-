import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { t } from 'i18n';
import { MAX_INGEST_BYTES, type IngestInput } from 'platform/pii';
import { buildClientAssets, type ClientAssets } from '../src/client-build.js';
import { createUploadServer } from '../src/server.js';

let assets: ClientAssets;
let base: string;
let close: () => Promise<void>;
const seen: IngestInput[] = [];
const KEY_B64 = Buffer.alloc(1216, 5).toString('base64');

beforeAll(async () => {
  assets = await buildClientAssets();
  const server = createUploadServer({
    assets, recipientPublicKeyB64: KEY_B64,
    ingest: async (input) => { seen.push(input); return input.token === 'good' ? { status: 204 } : { status: 401, error: 'invalid_token' }; },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});
afterAll(() => close());

const cspOf = (res: Response): Map<string, string> =>
  new Map(res.headers.get('content-security-policy')!.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0]!, d.split(' ').slice(1).join(' ')]));

describe('submit page: CSP and SRI (Review Focus 2)', () => {
  it('serves a script whose SRI hash matches both the script tag and the CSP, and nothing else is allowed to run', async () => {
    for (const loc of ['ja', 'en'] as const) {
      const res = await fetch(`${base}/${loc}/submit?token=x`);
      expect(res.status).toBe(200);
      const html = await res.text();
      const tag = /<script type="module" src="([^"]+)" integrity="([^"]+)" crossorigin="anonymous"><\/script>/.exec(html);
      expect(tag, 'one SRI script tag').not.toBeNull();
      const js = Buffer.from(await (await fetch(base + tag![1]!)).arrayBuffer());
      const sri = `sha384-${createHash('sha384').update(js).digest('base64')}`;
      expect(tag![2]).toBe(sri);
      const csp = cspOf(res);
      expect(csp.get('script-src')).toBe(`'${sri}'`); // the hash only: no 'self', no 'unsafe-inline', no 'unsafe-eval'
      expect(html.match(/<script/g)).toHaveLength(1); // no inline script
      expect(html).not.toMatch(/\son[a-z]+=|style=|javascript:/i); // no inline handlers or styles
    }
  });

  it('starts from default-src none, denies framing, and allows no third party', async () => {
    const res = await fetch(`${base}/ja/submit`);
    const csp = cspOf(res);
    expect(csp.get('default-src')).toBe("'none'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('connect-src')).toBe("'self'");
    expect(csp.get('style-src')).toBe("'self'");
    expect(csp.get('form-action')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect([...csp.values()].join(' ')).not.toMatch(/unsafe-|\*|https?:|data:|blob:/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    const html = await res.text();
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//); // no third-party resource of any kind
    expect(html).toContain('<link rel="stylesheet" href="/assets/submit.css">');
  });

  it('applies the same headers to the assets and the ingest responses', async () => {
    for (const res of [await fetch(base + assets.script.path), await fetch(base + assets.style.path), await fetch(`${base}/ingest/id-upload`, { method: 'POST' }), await fetch(`${base}/nope`)]) {
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('shows "we never ask for it by email" in both languages, and never accepts a file by email', async () => {
    expect(await (await fetch(`${base}/ja/submit`)).text()).toContain(t('ja', 'verification.noEmailNotice'));
    expect(await (await fetch(`${base}/en/submit`)).text()).toContain(t('en', 'verification.noEmailNotice'));
    expect(t('ja', 'verification.noEmailNotice')).toContain('メール');
    expect(t('en', 'verification.noEmailNotice')).toMatch(/email/i);
  });

  it('embeds only the public key and a bundle with no network origin of its own', async () => {
    const html = await (await fetch(`${base}/ja/submit`)).text();
    expect(html).toContain(`<meta name="id-recipient-key" content="${KEY_B64}">`);
    const js = Buffer.from(assets.script.body).toString('utf8');
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).toContain('/ingest/id-upload'); // the one endpoint it talks to, same origin
  });

  it('serves only /ja/submit and /en/submit', async () => {
    expect((await fetch(`${base}/fr/submit`)).status).toBe(404);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/ja/submit`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe('POST /ingest/id-upload', () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}, path = '/ingest/id-upload') =>
    fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream', ...headers } });

  it('hands the bearer token, content type and raw body to the intake; ids in the request are never forwarded', async () => {
    seen.length = 0;
    const body = new Uint8Array([1, 2, 3, 4]);
    const res = await post(body, { authorization: 'Bearer good', 'x-upload-id': 'other-upload', 'x-account-id': 'other-account' }, '/ingest/id-upload?uploadId=other-upload&accountId=other-account');
    expect(res.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ token: 'good', contentType: 'application/octet-stream', body: Buffer.from(body) });
    expect(Object.keys(seen[0]!).sort()).toEqual(['body', 'contentType', 'token']);
  });

  it('answers 401 without a valid token and 405 for other methods', async () => {
    expect((await post(new Uint8Array([1]))).status).toBe(401);
    expect((await post(new Uint8Array([1]), { authorization: 'Bearer bad' })).status).toBe(401);
    expect((await fetch(`${base}/ingest/id-upload`)).status).toBe(405);
  });

  it('refuses an oversized body with 413 before it reaches the intake', async () => {
    seen.length = 0;
    const res = await post(new Uint8Array(MAX_INGEST_BYTES + 10), { authorization: 'Bearer good' });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });
});
