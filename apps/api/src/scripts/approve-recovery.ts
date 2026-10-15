import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { createMailer } from '../mail/mailer.js';
import { approveRecovery } from '../auth/recovery.js';

const requestId = process.argv[2];
if (!requestId) {
  console.error('usage: pnpm --filter api admin:approve-recovery <requestId>');
  process.exit(1);
}
const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const { newRecoveryCode } = await approveRecovery(db, createMailer(config.smtpUrl, config.mailFrom), requestId, config);
  console.log('Recovery approved. All sessions and passkeys were revoked; the user was emailed to log in by email.');
  console.log('New recovery code (shown ONCE, not stored or emailed):');
  console.log(newRecoveryCode);
  console.log('Give it to the user out-of-band (e.g. in person) after verifying their identity.');
} finally {
  await sql.end();
}
