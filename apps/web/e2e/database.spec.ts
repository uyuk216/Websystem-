import { expect, test } from '@playwright/test';
import { grantStudent, newEmail, signUp } from './helpers';

const appName = () => `e2e-db-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test('dynamic app database: add, back up, delete (password never shown)', async ({ page }) => {
  test.setTimeout(120_000);
  const email = newEmail();
  await signUp(page, email, 'en');
  grantStudent(email);
  const name = appName();
  await page.goto('/en/apps');
  await page.getByLabel('App name (subdomain)').fill(name);
  await page.getByLabel('Type').selectOption('dynamic');
  await page.getByRole('button', { name: 'Create app' }).click();
  await page.getByRole('link', { name }).click();

  const panel = page.getByTestId('database-panel');
  await panel.getByRole('button', { name: 'Add a database' }).click();
  await expect(panel.getByText('The database is ready.')).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText(/Used [\d.]+ MB of 256\.0 MB/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText('postgres://');

  await panel.getByRole('button', { name: 'Back up now' }).click();
  await expect(panel.getByRole('button', { name: 'Restore to this point' })).toHaveCount(1, { timeout: 30_000 });

  page.once('dialog', (d) => void d.accept());
  await panel.getByRole('button', { name: 'Delete database' }).click();
  await expect(panel.getByRole('button', { name: 'Add a database' })).toBeVisible({ timeout: 30_000 });
});
