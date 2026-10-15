import { expect, test } from '@playwright/test';
import { codeOf, linkOf, loginWithCode, newEmail, nextMail, signUp } from './helpers';

test.use({ locale: 'ja-JP' });

test('登録してメールでログインできる（日本語）', async ({ page, browser }) => {
  const email = newEmail();
  await page.goto('/ja/signup');
  await page.getByLabel('メールアドレス').fill(email);
  await page.locator('form button[type=submit]').click();
  await page.locator('#code').fill(codeOf(await nextMail(email)));
  await page.locator('form button[type=submit]').click();
  await page.locator('#dn').fill('テスト太郎');
  await page.locator('#bd').fill('2000-01-01');
  await page.locator('form button[type=submit]').click();

  // The recovery code is shown once; "next" stays disabled until the box is checked.
  await expect(page.getByRole('heading', { name: '復旧コード' })).toBeVisible();
  expect((await page.getByTestId('recovery-code').textContent())!.length).toBeGreaterThan(8);
  const next = page.getByRole('button', { name: '次へ' });
  await expect(next).toBeDisabled();
  await page.getByRole('checkbox', { name: '復旧コードを保存しました' }).check();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.getByRole('heading', { name: 'パスキーを登録しましょう' })).toBeVisible();
  await page.getByRole('button', { name: 'あとで登録する' }).click();
  await expect(page).toHaveURL(/\/ja\/settings\/devices/);

  // A second browser logs in with the emailed code.
  const ctx = await browser.newContext({ locale: 'ja-JP' });
  const p2 = await ctx.newPage();
  await loginWithCode(p2, email);
  await expect(p2.getByRole('heading', { name: 'ログイン中の端末' })).toBeVisible();
  await ctx.close();
});

test.describe('en', () => {
  test.use({ locale: 'en-US' });
  test('English UI', async ({ page }) => {
    await page.goto('/en/login');
    await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with a passkey' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Log in with email' })).toBeVisible();
    await page.goto('/'); // Accept-Language en-US -> /en
    await expect(page).toHaveURL(/\/en\//);
  });
});

const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * Device A (laptop) requests the login. The mailed link is opened on the phone, and that same phone
 * scans the QR code from A's screen and confirms. Only the browser that opened the link may confirm.
 */
async function startCrossDevice(browser: import('@playwright/test').Browser) {
  const email = newEmail();
  const setup = await browser.newContext({ locale: 'ja-JP' });
  await signUp(await setup.newPage(), email);
  await setup.close();
  const ctxA = await browser.newContext({ locale: 'ja-JP', userAgent: MAC_SAFARI });
  const a = await ctxA.newPage();
  await a.goto('/ja/login');
  await a.locator('#email').fill(email);
  await a.locator('form button[type=submit]').click();
  const link = linkOf(await nextMail(email));
  const ctxB = await browser.newContext({ locale: 'ja-JP', userAgent: IPHONE_SAFARI });
  const b = await ctxB.newPage();
  await b.goto(link.pathname + link.search); // /login/link?c=&t= -> locale redirect keeps the query
  await expect(b.getByText('この端末ではログインしていません')).toBeVisible();
  const qr = a.getByTestId('login-qr');
  await expect(qr).toBeVisible();
  const payload = new URL((await qr.getAttribute('data-payload'))!);
  const number = (await a.getByTestId('login-number').textContent())!.trim();
  return { a, ctxA, b, payload, number, close: async () => { await ctxA.close(); await ctxB.close(); } };
}

test('リンクを開いた端末で QR を読み取り、正しい数字を選ぶとログインできる', async ({ browser }) => {
  const s = await startCrossDevice(browser);
  // The phone (same browser context that opened the mailed link) scans the QR code.
  await s.b.goto(s.payload.pathname + s.payload.search);
  await expect(s.b.getByRole('heading', { name: 'ログインの確認' })).toBeVisible();
  await expect(s.b.locator('dd').first()).toHaveText('Mac / Safari'); // the requesting device
  await expect(s.b.locator('.choices button')).toHaveCount(3);
  await s.b.getByRole('button', { name: s.number, exact: true }).click();
  await expect(s.b.getByText('承認しました')).toBeVisible();
  await expect(s.a).toHaveURL(/settings\/devices/, { timeout: 15_000 });
  await s.close();
});

test('要求元の端末（攻撃者の画面）では QR を読み込んでも確認できない', async ({ browser }) => {
  const s = await startCrossDevice(browser);
  // The requester sees both the QR payload and the number on its own screen, but its device id is not the opener's.
  await s.a.goto(s.payload.pathname + s.payload.search);
  await expect(s.a.getByText('この確認は無効か、期限切れです。')).toBeVisible();
  await expect(s.a.locator('.choices button')).toHaveCount(0);
  const res = await s.ctxA.request.post('/api/auth/email/confirm', {
    data: { challengeId: s.payload.searchParams.get('c'), scanToken: s.payload.searchParams.get('s'), chosen: Number(s.number) },
  });
  expect(res.status()).toBe(400);
  // The refused confirm killed the challenge: the phone can no longer approve it either.
  await s.b.goto(s.payload.pathname + s.payload.search);
  await expect(s.b.getByText('この確認は無効か、期限切れです。')).toBeVisible();
  await s.a.goto('/ja/login');
  await expect(s.a).not.toHaveURL(/settings/);
  await s.close();
});

test('間違った数字を選ぶとログインできない', async ({ browser }) => {
  const s = await startCrossDevice(browser);
  await s.b.goto(s.payload.pathname + s.payload.search);
  await expect(s.b.locator('.choices button')).toHaveCount(3);
  const wrong = (await s.b.locator('.choices button').allTextContents()).find((n) => n !== s.number)!;
  await s.b.getByRole('button', { name: wrong, exact: true }).click();
  await expect(s.b.getByText('数字が違います')).toBeVisible();
  // A's next poll sees the failed challenge: QR and number disappear, and it never reaches the app.
  await expect(s.a.getByTestId('login-qr')).toBeHidden({ timeout: 10_000 });
  await expect(s.a.getByTestId('login-number')).toBeHidden();
  await expect(s.a).not.toHaveURL(/settings/);
  await s.close();
});

test('端末一覧から他の端末をログアウトできる', async ({ browser }) => {
  const email = newEmail();
  const ctxA = await browser.newContext({ locale: 'ja-JP' });
  const a = await ctxA.newPage();
  await signUp(a, email);
  const ctxB = await browser.newContext({ locale: 'ja-JP' });
  const b = await ctxB.newPage();
  await loginWithCode(b, email);
  await a.reload();
  await expect(a.locator('tbody tr')).toHaveCount(2);
  await expect(a.locator('tr[data-current=true]')).toHaveCount(1);
  await a.locator('tr[data-current=false] button').click();
  await expect(a.locator('tbody tr')).toHaveCount(1);
  await b.reload();
  await expect(b).toHaveURL(/\/ja\/login/);
  await ctxA.close();
  await ctxB.close();
});

test('ページにパスワード入力欄がない', async ({ page }) => {
  for (const path of ['/ja/login', '/ja/signup', '/ja/recover']) {
    await page.goto(path);
    await expect(page.locator('input[type=password]')).toHaveCount(0);
  }
});
