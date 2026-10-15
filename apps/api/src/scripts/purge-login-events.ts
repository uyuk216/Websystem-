import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { purgeWebauthnChallenges } from '../auth/passkeys.js';
import { purgeOldLoginEvents } from '../auth/login-history.js';

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const now = new Date();
  const n = await purgeOldLoginEvents(db, now);
  const c = await purgeWebauthnChallenges(db, now);
  console.log(`Deleted ${c} expired/consumed WebAuthn challenge(s).`);
  console.log(`Deleted ${n} login event(s) older than 30 days.`);
} finally {
  await sql.end();
}
