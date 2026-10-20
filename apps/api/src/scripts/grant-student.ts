import { loadConfig } from '../config.js';
import { createDb, withSystem } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { hashEmail, normalizeEmail } from '../crypto/email.js';
import { endOfMarchJst } from 'shared';
import { grantStudent } from '../grants/grants.js';

/**
 * 開発・テスト用: メールアドレスのアカウントに Student の付与をする（学生証の審査を通さない）。
 * Playwright の E2E が動的アプリ・DB を作る前に呼ぶ。本番では動かない。付与は 2100 年 3 月末まで。
 */
if (process.env.NODE_ENV === 'production') {
  console.error('grant-student is a development tool and refuses to run in production.');
  process.exit(1);
}
const email = process.argv[2];
if (!email) {
  console.error('usage: pnpm --filter api admin:grant-student <email>');
  process.exit(1);
}
const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const [a] = await withSystem(db, (tx) => tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.emailHash, hashEmail(normalizeEmail(email), config.emailHashKey))));
  if (!a) {
    console.error('No account with that email.');
    process.exit(1);
  }
  await grantStudent(db, a.id, endOfMarchJst(2100), { reason: 'dev/e2e grant', approvedBy: 'system' });
  console.log(`Student granted to ${a.id}.`);
} finally {
  await sql.end();
}
