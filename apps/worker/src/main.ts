import { createQueue, createStorage, loadStorageConfig, startQueue } from 'platform';
import { createDb } from 'api/db';
import { sweepStaleDeployments } from 'api/publish';
import { createDynamicRuntime } from 'api/dynamic';
import { createWakeLocker, sleepIdleApps } from 'api/wake';
import { startRuntimeMetering } from 'api/runtime-hours';
import { startDatabaseWatch } from 'api/database-watch';
import { startScheduledBackups } from 'api/database-backups';
import { createMailer } from 'api/mailer';
import { defaultHandlers, registerHandlers } from './worker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing required env var: DATABASE_URL');

// Throws with a clear message when the dynamic runtime is enabled but APP_ENV_KEY is missing.
const { db, sql } = createDb(databaseUrl);
const runtime = createDynamicRuntime(process.env, { db });
const locker = runtime ? createWakeLocker(databaseUrl, 4) : undefined;
if (runtime && locker) runtime.lock = locker.lock;
const storage = createStorage(loadStorageConfig(process.env));
await storage.ensureBuckets();
const boss = await startQueue(createQueue(databaseUrl));
await registerHandlers(boss, defaultHandlers({ db, storage, runtime }));

// Stale `queued` deployments (never enqueued, or the enqueuing process died) are failed at startup and every 10 minutes.
const sweep = () => sweepStaleDeployments(db).then((n) => { if (n > 0) console.log(`worker: failed ${n} stale queued deployment(s)`); }, (e: unknown) => console.error('worker: stale sweep failed', e));
await sweep();
const sweepTimer = setInterval(() => void sweep(), 10 * 60_000);
sweepTimer.unref();

// Dynamic apps idle longer than DYNAMIC_LIMITS.sleepAfterMinutes are stopped (the edge wakes them on demand).
// Safe with several workers: each app is stopped under its wake lock.
if (runtime) {
  const sleepTick = () => sleepIdleApps(db, runtime.driver).then((ids) => { for (const id of ids) console.log(`worker: app ${id} went to sleep`); }, (e: unknown) => console.error('worker: sleep sweep failed', e));
  const sleepTimer = setInterval(() => void sleepTick(), 60_000);
  sleepTimer.unref();
}

// Runtime-hour metering: one tick per minute (idempotent per app-minute, so several workers do not double count).
if (runtime) {
  const emailKey = process.env.EMAIL_ENC_KEY ? Buffer.from(process.env.EMAIL_ENC_KEY, 'base64') : undefined;
  const mailer = process.env.SMTP_URL ? createMailer(process.env.SMTP_URL, process.env.MAIL_FROM || 'no-reply@localhost') : undefined;
  startRuntimeMetering({ db, driver: runtime.driver, mailer, emailKey });
  // User databases: size check every 5 minutes (80% mail, read-only at 100%, refused beyond the hard limit).
  if (runtime.databases) {
    startDatabaseWatch({ db, databases: runtime.databases, mailer, emailKey });
    // Hourly backups (checked every 10 minutes), kept for DATABASE_LIMITS.backupRetentionDays.
    startScheduledBackups(db, storage, runtime);
  }
}
console.log('worker: waiting for jobs');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void boss.stop({ graceful: true }).finally(() => {
      void locker?.close();
      storage.close();
      void sql.end();
      process.exit(0);
    });
  });
}
