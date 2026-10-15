import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createQueue, JOBS, startQueue } from 'platform';
import { defaultHandlers, registerHandlers } from '../src/worker.js';

const URL_ = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform';

describe('worker', () => {
  it('calls the handler registered for each job name', async () => {
    const name = `test_${randomUUID().replace(/-/g, '')}`;
    const admin = postgres(URL_, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${name}"`);
    const u = new URL(URL_);
    u.pathname = `/${name}`;
    const boss = await startQueue(createQueue(u.toString()));
    try {
      const seen: unknown[] = [];
      const done = new Promise<void>((resolve) => {
        const handlers = defaultHandlers();
        handlers[JOBS.deleteAppStorage] = async (d) => {
          seen.push(d);
          resolve();
        };
        void registerHandlers(boss, handlers);
      });
      await boss.send(JOBS.deleteAppStorage, { appId: 'a1' });
      await done;
      expect(seen).toEqual([{ appId: 'a1' }]);
    } finally {
      await boss.stop({ graceful: false });
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  }, 30000);
});
