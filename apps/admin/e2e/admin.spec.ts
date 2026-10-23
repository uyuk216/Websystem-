import { test, expect } from '../../upload/playwright-api.js';

test.beforeEach(async ({ page }) => {
  // Software authenticator signs the real challenge; the browser UI still serializes and submits the assertion.
  await page.addInitScript(() => {
    const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
    Object.defineProperty(navigator.credentials, 'get', { value: async (opts: CredentialRequestOptions) => {
      const challenge = btoa(String.fromCharCode(...new Uint8Array(opts.publicKey!.challenge as ArrayBuffer))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      const data = await (await fetch('/__test/assert', { method: 'POST', body: JSON.stringify({ challenge }) })).json();
      return { ...data, rawId: decode(data.rawId), getClientExtensionResults: () => ({}), response: Object.fromEntries(Object.entries(data.response as Record<string, string>).map(([k, v]) => [k, decode(v)])) };
    } });
  });
});

test('upload → local image review → reject/resubmit → Student approval → dynamic app and ciphertext deletion', async ({ page, request }) => {
  const first = await (await request.post('/__test/submit', { data: {} })).json();
  async function submit(url: string) {
    await page.goto(url);
    const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8; canvas.getContext('2d')!.fillRect(0, 0, 8, 8); return canvas.toDataURL('image/png').split(',')[1]!; });
    await page.setInputFiles('#file', { name: 'id.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.click('button[type=submit]'); await expect(page.locator('#status')).toContainText('提出しました');
  }
  await submit(first.ok.uploadUrl);
  await page.clock.install();
  await page.goto('/'); await page.getByText('パスキーで昇格ログイン').click();
  await expect(page.locator('#status')).toContainText('ログイン済み');
  let review = page.locator('article').filter({ hasText: first.id });
  await review.getByText('画像を開く').click();
  await page.setInputFiles('#secret', { name: 'key.txt', mimeType: 'text/plain', buffer: Buffer.from(first.secretKey) });
  await page.getByText('ローカル復号', { exact: true }).click();
  await expect(page.locator('#image')).toBeVisible();
  expect(await page.locator('#image').evaluate((img) => { const e = new Event('contextmenu', { cancelable: true }); return !img.dispatchEvent(e); })).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#image')).toBeHidden(); await expect(page.locator('#image')).not.toHaveAttribute('src');
  await page.clock.resume();
  await review.getByLabel('差し戻し理由').fill('新しい書類で再提出してください'); await review.getByText('差し戻し', { exact: true }).click();
  await expect(review).toHaveCount(0);
  expect((await (await request.post('/__test/check', { data: { id: first.id } })).json()).blobs).toBe(0);
  const next = await (await request.post('/__test/submit', { data: { id: first.id } })).json();
  await submit(next.ok.uploadUrl); await page.goto('/');
  review = page.locator('article').filter({ hasText: first.id });
  await review.getByLabel('新年度の書類を確認済み').check(); await review.getByText('承認', { exact: true }).click();
  await expect(review).toHaveCount(0);
  const result = await (await request.post('/__test/check', { data: { id: first.id, create: 'yes' } })).json();
  expect(result.plan.plan).toBe('student'); expect(result.blobs).toBe(0); expect(result.created.appId).toBeTruthy();
  await page.getByRole('button', { name: '記録', exact: true }).click();
  await expect(page.locator('#screen')).toContainText('reviews.image');
  await page.getByText('ハッシュ連鎖を検証').click(); await expect(page.locator('#screen')).toContainText('"ok": true');
});

test('Starter approval period/notices and boost adjustment only during the period', async ({ page, request }) => {
  const starter = await (await request.post('/__test/starter', { data: {} })).json();
  await page.goto('/'); await page.getByText('パスキーで昇格ログイン').click();
  await page.getByRole('button', { name: '付与', exact: true }).click();
  const end = new Date(Date.now() + 60 * 86400_000); end.setSeconds(0, 0);
  const card = page.locator('article').filter({ hasText: starter.ok.applicationId });
  // datetime-local follows the browser's local timezone.
  const localEnd = new Date(end.getTime() - end.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await card.getByLabel('終了日時').fill(localEnd); await card.getByText('承認', { exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await (await request.post('/__test/check', { data: { id: starter.id } })).json()).plan.plan).toBe('starter');
  const at = String(end.getTime() - 14 * 86400_000 + 1000);
  expect((await (await request.post('/__test/notices', { data: { at } })).json()).sent).toBe(1);
  expect((await (await request.post('/__test/notices', { data: { at } })).json()).sent).toBe(0);
  const boost = await (await request.post('/__test/boost', { data: { id: starter.id } })).json();
  await page.getByRole('button', { name: '付与', exact: true }).click();
  const b = page.locator('article').filter({ hasText: boost.ok.boostId });
  await b.getByLabel('追加転送量 (bytes)').fill('4096'); await b.getByLabel('追加メモリ (MB)').fill('256'); await b.getByText('承認', { exact: true }).click();
  await expect(b).toHaveCount(0);
  const limits = async (at: string) => (await request.post('/__test/limits', { data: { id: starter.id, appId: boost.appId, at } })).json();
  const during = await limits(boost.start), after = await limits(new Date(new Date(boost.end).getTime() + 1).toISOString());
  expect(during.dynamic.memoryMb - after.dynamic.memoryMb).toBe(256);
  expect(during.static.monthlyTransferBytes - after.static.monthlyTransferBytes).toBe(4096);
  expect(during.dynamic.sleepAfterMinutes).toBeNull();
  expect(after.dynamic.sleepAfterMinutes).toBeGreaterThan(0);
});

test('non-operator cannot enter the admin API or expose operation screens', async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'tailscale-user-login': 'plain@tailnet' });
  await page.goto('/');
  await expect(page.locator('#ops')).toBeHidden();
  expect((await page.request.get('/admin/me', { headers: { 'tailscale-user-login': 'plain@tailnet' } })).status()).toBe(404);
});
