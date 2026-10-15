import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createQueue, JOBS, startQueue } from '../src/index.js';

const URL_ = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://platform:platform@localhost:54320/platform';

describe('queue', () => {
  it('delivers a sent job to the registered handler', async () => {
    const name = `test_${randomUUID().replace(/-/g, '')}`;
    const admin = postgres(URL_, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database "${name}"`);
    const u = new URL(URL_);
    u.pathname = `/${name}`;
    const boss = await startQueue(createQueue(u.toString()));
    try {
      const got = new Promise<unknown>((resolve) => {
        void boss.work(JOBS.processDeployment, { pollingIntervalSeconds: 0.5 }, async (jobs) => resolve(jobs[0]!.data));
      });
      await boss.send(JOBS.processDeployment, { deploymentId: 'd1' });
      expect(await got).toEqual({ deploymentId: 'd1' });
    } finally {
      await boss.stop({ graceful: false });
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  }, 20000);
});
