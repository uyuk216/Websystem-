import { expect, test, type Page } from '@playwright/test';
import { newEmail, signUp } from './helpers';
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
  await expect(page.locator('p.error')).toHaveText('Choose a ZIP file.');
});

// Blocked until Task 7 (API tokens) is merged: GET/POST /me/tokens and DELETE /me/tokens/:id do not exist yet.
test.fixme('token is shown only once', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await page.goto('/en/settings/tokens');
  await page.getByLabel('Token name').fill('laptop');
  await page.getByRole('button', { name: 'Create token' }).click();
  const token = await page.getByTestId('new-token').textContent();
  expect(token!.length).toBeGreaterThan(10);
  await page.reload();
  await expect(page.getByTestId('new-token')).toHaveCount(0);
  await expect(page.getByText(token!)).toHaveCount(0);
  await expect(page.getByRole('rowheader', { name: 'laptop' })).toBeVisible();
});

// Blocked until Task 6 (GitHub settings) is merged: PATCH /apps/:id/github does not exist yet.
test.fixme('saves GitHub settings', async ({ page }) => {
  await signUp(page, newEmail(), 'en');
  await createApp(page, appName());
  await page.getByLabel('Repository (owner/repo)').fill('octo/site');
  await page.getByLabel('Branch').fill('main');
  await page.getByLabel('Installation ID').fill('123');
  await page.getByRole('button', { name: 'Save integration' }).click();
  await expect(page.locator('p.error')).toHaveCount(0);
});
