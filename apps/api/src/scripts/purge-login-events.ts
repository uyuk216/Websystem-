import { loadConfig } from '../config.js';
import { createDb } from '../db/client.js';
import { purgeOldLoginEvents } from '../auth/login-history.js';

const config = loadConfig(process.env);
const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const n = await purgeOldLoginEvents(db, new Date());
  console.log(`Deleted ${n} login event(s) older than 30 days.`);
} finally {
  await sql.end();
}
