import { createQueue, createStorage, loadStorageConfig, startQueue } from 'platform';
import { createDb } from 'api/db';
import { defaultHandlers, registerHandlers } from './worker.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Missing required env var: DATABASE_URL');

const storage = createStorage(loadStorageConfig(process.env));
await storage.ensureBuckets();
const boss = await startQueue(createQueue(databaseUrl));
const { db, sql } = createDb(databaseUrl);
await registerHandlers(boss, defaultHandlers({ db, storage }));
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
