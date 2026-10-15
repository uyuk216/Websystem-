import { createQueue, createStorage, loadStorageConfig, startQueue } from 'platform';
import { createDb } from 'api/db';
import { sweepStaleDeployments } from 'api/publish';
import { createDynamicRuntime } from 'api/dynamic';
import { startRuntimeMetering } from 'api/runtime-hours';
import { createMailer } from 'api/mailer';
import { defaultHandlers, registerHandlers } from './worker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing required env var: DATABASE_URL');

// Throws with a clear message when the dynamic runtime is enabled but APP_ENV_KEY is missing.
const runtime = createDynamicRuntime(process.env);
const storage = createStorage(loadStorageConfig(process.env));
await storage.ensureBuckets();
const boss = await startQueue(createQueue(databaseUrl));
const { db, sql } = createDb(databaseUrl);
await registerHandlers(boss, defaultHandlers({ db, storage, runtime }));

// Stale `queued` deployments (never enqueued, or the enqueuing process died) are failed at startup and every 10 minutes.
const sweep = () => sweepStaleDeployments(db).then((n) => { if (n > 0) console.log(`worker: failed ${n} stale queued deployment(s)`); }, (e: unknown) => console.error('worker: stale sweep failed', e));
await sweep();
const sweepTimer = setInterval(() => void sweep(), 10 * 60_000);
sweepTimer.unref();
// Runtime-hour metering: one tick per minute (idempotent per app-minute, so several workers do not double count).
if (runtime) {
  const emailKey = process.env.EMAIL_ENC_KEY ? Buffer.from(process.env.EMAIL_ENC_KEY, 'base64') : undefined;
  const mailer = process.env.SMTP_URL ? createMailer(process.env.SMTP_URL, process.env.MAIL_FROM || 'no-reply@localhost') : undefined;
  startRuntimeMetering({ db, driver: runtime.driver, mailer, emailKey });
}
console.log('worker: waiting for jobs');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void boss.stop({ graceful: true }).finally(() => {
      storage.close();
      void sql.end();
      process.exit(0);
    });
  });
}
