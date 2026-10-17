import { expect, test } from '@playwright/test';
import { linkOf, newEmail, nextMail } from './helpers';

test('signup can continue from the mailed link in the same browser', async ({ page }) => {
  const email = newEmail();
  await page.goto('/ja/signup');
  await page.getByLabel('メールアドレス').fill(email);
  await page.locator('form button[type=submit]').click();
  await expect(page.locator('#code')).toBeVisible();

  const link = linkOf(await nextMail(email));
  expect(link.pathname).toBe('/ja/signup');
  await page.goto(link.pathname + link.search);
  // The code step is skipped; the token is removed from the address bar.
  await expect(page.locator('#dn')).toBeVisible();
  expect(page.url()).not.toContain('t=');
  await page.locator('#dn').fill('Link User');
  await page.locator('#bd').fill('2000-01-01');
  await page.locator('form button[type=submit]').click();
  await expect(page.getByTestId('recovery-code')).toBeVisible();
});

test('the signup link opened in another browser asks to use the starting browser', async ({ page, browser }) => {
  const email = newEmail();
  await page.goto('/ja/signup');
  await page.getByLabel('メールアドレス').fill(email);
  await page.locator('form button[type=submit]').click();
  const link = linkOf(await nextMail(email));

  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(link.pathname + link.search);
  await expect(p2.locator('p[role=alert]')).toContainText('同じブラウザ');
  await expect(p2.locator('#dn')).toHaveCount(0);
  await other.close();
});
