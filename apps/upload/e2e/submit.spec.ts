import { randomUUID, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { expect, test, type Request } from '@playwright/test';
import { decryptIdImage, parseEnvelope } from 'shared';

const TOKEN = (uploadId: string, accountId: string): string => `${uploadId}.${accountId}.${randomBytes(32).toString('base64url')}`;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A 64x40 RGB PNG with noise, carrying a recognisable text chunk ("filename") that must not survive. */
function testPng(): Buffer {
  const w = 64, h = 40;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = (x * 7 + y * 13) & 255;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Comment\0SECRET-STUDENT-NAME-TARO-YAMADA')), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('the page encrypts in the browser: no plaintext image on the wire, and Node decrypts the same envelope', async ({ page }) => {
  const uploadId = randomUUID(), accountId = randomUUID();
  const png = testPng();
  const requests: Request[] = [];
  let posted: Buffer | null = null;
  let postHeaders: Record<string, string> = {};
  page.on('request', (r) => requests.push(r));
  await page.route('**/ingest/id-upload', async (route) => {
    posted = route.request().postDataBuffer();
    postHeaders = route.request().headers();
    await route.fulfill({ status: 204 });
  });
  const csp: string[] = [];
  page.on('console', (m) => { if (/content security policy/i.test(m.text())) csp.push(m.text()); });

  await page.goto(`/ja/submit?token=${TOKEN(uploadId, accountId)}`);
  // The token leaves the address bar immediately.
  await expect.poll(() => page.url()).not.toContain('token');
  await page.setInputFiles('#file', { name: 'taro-yamada-student-id.png', mimeType: 'image/png', buffer: png });
  await page.click('button[type=submit]');
  await expect(page.locator('#status')).toContainText('提出しました');

  // Only the page, its two same-origin assets and one POST of the envelope left the browser.
  const origins = new Set(requests.map((r) => new URL(r.url()).origin));
  expect([...origins]).toEqual(['http://127.0.0.1:5175']);
  const posts = requests.filter((r) => r.method() === 'POST');
  expect(posts).toHaveLength(1);
  expect(requests.filter((r) => r.method() !== 'GET' && r.method() !== 'POST')).toHaveLength(0);
  expect(requests.every((r) => !r.url().startsWith('blob:') && !r.url().startsWith('data:'))).toBe(true);

  expect(posted).not.toBeNull();
  const body = posted as unknown as Buffer;
  expect(postHeaders['content-type']).toBe('application/octet-stream');
  expect(postHeaders['authorization']).toMatch(/^Bearer /);
  // No plaintext: not the original file, not its PNG signature, not the text chunk, not the file name, no JPEG signature up front.
  expect(body.includes(png.subarray(0, 64))).toBe(false);
  expect(body.includes(Buffer.from('SECRET-STUDENT-NAME'))).toBe(false);
  expect(body.includes(Buffer.from('taro-yamada'))).toBe(false);
  expect(body.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  expect(body.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
  expect(body.length).toBeGreaterThan(1100);

  // The browser's envelope opens in Node with the matching secret key and the ids bound into it: a JPEG without the text chunk.
  const secretKey = Uint8Array.from(Buffer.from(process.env.E2E_SECRET_KEY!, 'base64'));
  const image = await decryptIdImage({ envelope: parseEnvelope(new Uint8Array(body)), secretKey, uploadId, accountId });
  expect([...image.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(Buffer.from(image).includes(Buffer.from('SECRET-STUDENT-NAME'))).toBe(false);
  // Wrong upload / account ids are refused by the AAD.
  await expect(decryptIdImage({ envelope: parseEnvelope(new Uint8Array(body)), secretKey, uploadId: randomUUID(), accountId })).rejects.toThrow();
  await expect(decryptIdImage({ envelope: parseEnvelope(new Uint8Array(body)), secretKey, uploadId, accountId: randomUUID() })).rejects.toThrow();
  expect(csp).toEqual([]);
});

test('an invalid link disables the form and sends nothing', async ({ page }) => {
  const requests: Request[] = [];
  page.on('request', (r) => requests.push(r));
  await page.goto('/en/submit?token=not-a-token');
  await expect(page.locator('#status')).toContainText('invalid or has expired');
  await expect(page.locator('#file')).toBeDisabled();
  expect(requests.filter((r) => r.method() === 'POST')).toHaveLength(0);
});

test('an unreadable image is reported and nothing is sent', async ({ page }) => {
  const uploadId = randomUUID(), accountId = randomUUID();
  let posts = 0;
  await page.route('**/ingest/id-upload', async (route) => { posts++; await route.fulfill({ status: 204 }); });
  await page.goto(`/en/submit?token=${TOKEN(uploadId, accountId)}`);
  await page.setInputFiles('#file', { name: 'id.heic', mimeType: 'image/heic', buffer: Buffer.from('not an image at all') });
  await page.click('button[type=submit]');
  await expect(page.locator('#status')).toContainText('cannot be read');
  expect(posts).toBe(0);
});

test('a refused token (401) tells the user to start again', async ({ page }) => {
  await page.route('**/ingest/id-upload', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_token"}' }));
  await page.goto(`/ja/submit?token=${TOKEN(randomUUID(), randomUUID())}`);
  await page.setInputFiles('#file', { name: 'a.png', mimeType: 'image/png', buffer: testPng() });
  await page.click('button[type=submit]');
  await expect(page.locator('#status')).toContainText('無効か、期限が切れています');
});
