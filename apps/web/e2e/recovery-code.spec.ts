import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { codeOf, newEmail, nextMail } from './helpers';

for (const locale of ['ja', 'en'] as const) {
  test(`recovery code can be saved as a .txt file (${locale})`, async ({ page }) => {
    const email = newEmail();
    await page.goto(`/${locale}/signup`);
    await page.getByLabel(locale === 'ja' ? 'メールアドレス' : 'Email address').fill(email);
    await page.locator('form button[type=submit]').click();
    await page.locator('#code').fill(codeOf(await nextMail(email)));
    await page.locator('form button[type=submit]').click();
    await page.locator('#dn').fill('Test User');
    await page.locator('#bd').fill('2000-01-01');
    await page.locator('form button[type=submit]').click();

    const shown = (await page.getByTestId('recovery-code').textContent())!.trim();
    expect(shown.length).toBeGreaterThan(8);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: locale === 'ja' ? 'ファイルに保存 (.txt)' : 'Save as file (.txt)' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^recovery-code-\d{8}\.txt$/);
    const text = await readFile((await download.path())!, 'utf8');
    expect(text).toContain(shown);
    expect(text).toContain(locale === 'ja' ? 'ログインできない場合' : "Can't log in?");
    await expect(page.getByRole('status').filter({ hasText: download.suggestedFilename() })).toBeVisible();
  });
}
