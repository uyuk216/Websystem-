import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';

const MAILPIT = 'http://localhost:8025/api/v1';
const seen = new Map<string, Set<string>>();

export const newEmail = (): string => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;

/** Waits for a mail to `to` that has not been returned before and returns its text body. */
export async function nextMail(to: string): Promise<string> {
  const known = seen.get(to) ?? new Set<string>();
  seen.set(to, known);
  let body = '';
  await expect.poll(async () => {
    const list = await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json() as { messages: { ID: string }[] };
    for (const m of [...list.messages].reverse()) { // oldest first
      if (known.has(m.ID)) continue;
      known.add(m.ID);
      body = ((await (await fetch(`${MAILPIT}/message/${m.ID}`)).json()) as { Text: string }).Text;
      return true;
    }
    return false;
  }, { timeout: 20_000 }).toBe(true);
  return body;
}

export const codeOf = (body: string): string => /\b(\d{6})\b/.exec(body)![1]!;
export const linkOf = (body: string): URL => new URL(/https?:\/\/\S+/.exec(body)![0]);

/** Signs up through the UI, saves the recovery code, skips the passkey step. */
export async function signUp(page: Page, email: string, locale: 'ja' | 'en' = 'ja'): Promise<string> {
  await page.goto(`/${locale}/signup`);
  await page.getByLabel(locale === 'ja' ? 'メールアドレス' : 'Email address').fill(email);
  await page.locator('form button[type=submit]').click();
  const code = codeOf(await nextMail(email));
  await page.locator('#code').fill(code);
  await page.locator('form button[type=submit]').click();
  await page.locator('#dn').fill('Test User');
  await page.locator('#bd').fill('2000-01-01');
  await page.locator('form button[type=submit]').click();
  const recovery = (await page.getByTestId('recovery-code').textContent())!;
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: locale === 'ja' ? '次へ' : 'Next', exact: true }).click();
  await page.getByRole('button', { name: locale === 'ja' ? 'あとで登録する' : 'Skip for now' }).click();
  await page.waitForURL(/settings\/devices/);
  return recovery;
}

/** Logs in with the mailed code on the login page. */
export async function loginWithCode(page: Page, email: string): Promise<void> {
  await page.goto('/ja/login');
  await page.locator('#email').fill(email);
  await page.locator('form button[type=submit]').click();
  await page.locator('#code').fill(codeOf(await nextMail(email)));
  await page.locator('form button[type=submit]').click();
  await page.waitForURL(/settings\/devices/);
}

/**
 * Gives the account a Student grant (dev tool, no ID review). Since phase 5 an account without a grant gets
 * `plan_required` for dynamic apps and databases, so the tests that create those call this after signing up.
 */
export function grantStudent(email: string): void {
  execFileSync('pnpm', ['--filter', 'api', 'admin:grant-student', email], { stdio: 'pipe' });
}
