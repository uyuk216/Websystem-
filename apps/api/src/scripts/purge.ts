import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { purgeWebauthnChallenges } from '../auth/passkeys.js';
import { purgeExpiredSessions } from '../auth/sessions.js';
import { purgeOldLoginEvents } from '../auth/login-history.js';
import { purgeGithubState } from '../github/link.js';
import { purgeRuntimeMinutes } from '../usage/runtime-hours.js';

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const now = new Date();
  const n = await purgeOldLoginEvents(db, now);
  const c = await purgeWebauthnChallenges(db, now);
  const s = await purgeExpiredSessions(db, now);
  const g = await purgeGithubState(db, now);
  const r = await purgeRuntimeMinutes(db, now);
  console.log(`Deleted ${r} runtime minute record(s) older than 400 days.`);
  console.log(`Deleted ${g} GitHub delivery/authorization record(s).`);
  console.log(`Deleted ${s} expired/revoked session(s).`);
  console.log(`Deleted ${c} expired/consumed WebAuthn challenge(s).`);
  console.log(`Deleted ${n} login event(s) older than 30 days.`);
} finally {
  await sql.end();
}
