import { test, expect } from '@playwright/test';
import { createDb } from '../../api/src/db/client.js';
import { grantStudent, newEmail, signUp } from './helpers';

// Review decisions are seeded in the test DB; the full operator review is covered by admin/e2e.
for (const locale of ['ja', 'en'] as const) {
  test(`${locale}: plan changes after a Student grant and a review reason is visible`, async ({ page }) => {
    const email = newEmail();
    await signUp(page, email, locale);
    await page.goto(`/${locale}/plan`);
    await expect(page.getByRole('heading', { name: locale === 'ja' ? 'なし' : 'None', exact: true })).toBeVisible();
    await grantStudent(email);
    await page.getByRole('button', { name: locale === 'ja' ? '最新の状況を確認' : 'Check latest status' }).click();
    await expect(page.getByRole('heading', { name: 'Student', exact: true })).toBeVisible();
    const started = await page.request.post(`/api/verification/start?locale=${locale}`, {
      data: { schoolName: 'Test University', schoolKind: 'university', expectedGraduationYear: new Date().getFullYear() + 2 },
    });
    expect(started.ok()).toBeTruthy();
    const { sql } = createDb(process.env.TEST_DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform');
    try {
      const { uploadId } = await started.json();
      const [upload] = await sql`select verification_id from verification_uploads where id = ${uploadId}`;
      expect(upload).toBeTruthy();
      await sql`update student_verifications set status = 'rejected', reject_reason = 'Please show the school name.' where id = ${upload!.verification_id}`;
      await page.goto(`/${locale}/verify`);
      await expect(page.getByRole('status').filter({ hasText: 'Please show the school name.' })).toBeVisible();
      await expect(page.getByRole('button', { name: locale === 'ja' ? '専用の提出画面へ進む' : 'Continue to the submission page' })).toBeVisible();
    } finally { await sql.end(); }
  });
}
