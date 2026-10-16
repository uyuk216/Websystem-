import { expect, test, type Page } from '@playwright/test';
import { newEmail, signUp } from './helpers';
import { randomBytes } from 'node:crypto';
import { makeZip } from './zip';

test.use({ locale: 'en-US' });

const STATIC = 'http://127.0.0.1:8090';
const appName = (): string => `e2e${Math.random().toString(36).slice(2, 10)}`;
/** Fetches a path of the static site by its host name (no DNS needed for *.localhost). */
const site = (page: Page, name: string, path: string) => page.request.get(`${STATIC}${path}`, { headers: { host: `${name}.localhost:8090` } });

/** The static server caches the site lookup for ~10s, so poll until the new version is served. */
const expectBody = (page: Page, name: string, path: string, text: string) =>
  expect.poll(async () => (await site(page, name, path)).text(), { timeout: 20_000 }).toContain(text);

async function createApp(page: Page, name: string): Promise<void> {
  await page.goto('/en/apps');
  await page.getByLabel('App name (subdomain)').fill(name);
  await page.getByRole('button', { name: 'Create app' }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

async function upload(page: Page, files: Record<string, string>): Promise<void> {
  await page.getByLabel('ZIP file').setInputFiles(await makeZip(files));
  await page.getByRole('button', { name: 'Upload ZIP' }).click();
}

test('upload, publish, .env hidden, secrets blocked, rollback', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  const name = appName();
  await createApp(page, name);
  await expect(page.getByTestId('site-url')).toHaveText(`http://${name}.localhost:8090`);

  await upload(page, { 'index.html': '<h1>version one</h1>' });
  await expect(page.getByTestId('status').first()).toHaveText('Live');
  await expectBody(page, name, '/', 'version one');

  // A .env inside the archive is dropped, never served; the rest is published.
  await upload(page, { 'index.html': '<h1>version two</h1>', '.env': 'FOO=bar' });
  await expect(page.getByTestId('status').first()).toHaveText('Live');
  await expect(page.getByTestId('status').nth(1)).toHaveText('Superseded');
  await expectBody(page, name, '/', 'version two');
  await expect.poll(async () => (await site(page, name, '/.env')).status(), { timeout: 20_000 }).toBe(404);

  // Secrets block the deployment; the live site is unchanged.
  await upload(page, { 'index.html': 'v3', 'app.js': 'const k = "AKIAABCDEFGHIJKLMNOP";' });
  await expect(page.getByTestId('status').first()).toHaveText('Secret detected');
  await expect(page.getByText('Move them to environment variables.')).toBeVisible();
  await expect(page.getByText('app.js:1')).toBeVisible();
  await expectBody(page, name, '/', 'version two');

  // Roll back to version one (the oldest superseded row).
  await page.getByRole('button', { name: 'Roll back to this version' }).last().click();
  await expectBody(page, name, '/', 'version one');
});

test('rejects non-zip uploads', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await createApp(page, appName());
  await page.getByLabel('ZIP file').setInputFiles(await makeZip({ 'index.html': 'x' }, 'site.txt'));
  await page.getByRole('button', { name: 'Upload ZIP' }).click();
  await expect(page.locator('p.error')).toHaveText('Please choose a ZIP file.');
});

test('too-large upload shows the size error and re-enables the button', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await createApp(page, appName());
  // The e2e API runs with UPLOAD_MAX_BYTES=100000; random data does not compress below it.
  const path = await makeZip({ 'index.html': randomBytes(200_000).toString('latin1') });
  await page.getByLabel('ZIP file').setInputFiles(path);
  await page.getByRole('button', { name: 'Upload ZIP' }).click();
  await expect(page.locator('p.error')).toHaveText('The file is too large (limit 200MB).');
  await expect(page.getByRole('button', { name: 'Upload ZIP' })).toBeEnabled();
});

test('token is shown only once', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await page.goto('/en/settings/tokens');
  await page.getByLabel('Token name').fill('laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = await page.getByTestId('new-token').textContent();
  expect(token!.length).toBeGreaterThan(10);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  await expect(page.getByText(token!)).toHaveCount(0);
  await expect(page.getByRole('rowheader', { name: 'laptop' })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke: laptop' }).click();
  await expect(page.getByRole('rowheader', { name: 'laptop' })).toHaveCount(0);
});

// GitHub itself cannot be reached in e2e; the real connect/PATCH flow is covered by API tests (apps/api/test/github.test.ts).
// Here: the form submits and an installation the account has not linked is rejected with 403.
test('GitHub form submits and asks to connect GitHub first', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await createApp(page, appName());
  await page.getByLabel('Repository (owner/repo)').fill('octo/site');
  await page.getByLabel('Branch').fill('main');
  await page.getByLabel('Installation ID').fill('12a3');
  await expect(page.getByLabel('Installation ID')).toHaveValue('123');
  await page.getByRole('button', { name: 'Save integration' }).click();
  await expect(page.locator('p.error')).toContainText('Connect GitHub first');
});

test('dynamic app: set env var (value never shown), list, delete', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  const name = appName();
  await page.goto('/en/apps');
  await page.getByLabel('App name (subdomain)').fill(name);
  await page.getByLabel('Type').selectOption('dynamic');
  await page.getByRole('button', { name: 'Create app' }).click();
  await page.getByRole('link', { name }).click();
  await expect(page.getByTestId('dynamic-panel')).toBeVisible();
  await expect(page.getByTestId('dyn-status')).toHaveText('Not deployed');

  await page.getByLabel('Name', { exact: true }).fill('GREETING');
  await page.getByLabel('Value').fill('hunter2-secret');
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  const list = page.getByTestId('env-list');
  await expect(list.locator('code', { hasText: 'GREETING' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('hunter2-secret');
  await page.reload();
  await expect(page.getByTestId('env-list').locator('code', { hasText: 'GREETING' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('hunter2-secret');

  await page.getByTestId('env-list').getByRole('button', { name: /Delete/ }).click();
  await expect(page.getByText('No environment variables.')).toBeVisible();
});
