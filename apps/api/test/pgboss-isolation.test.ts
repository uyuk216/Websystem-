import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createQueue, startQueue } from 'platform';
import { withTestDb } from './helpers/db.js';

describe('pgboss schema isolation', () => {
  it('platform_api has no access to the pgboss schema', async () => {
    await withTestDb(async (db) => {
      const o = (db.$client as unknown as { options: { host: string[]; port: number[]; user: string; pass: string; database: string } }).options;
      const url = `postgres://${o.user}:${o.pass}@${o.host[0]}:${o.port[0]}/${o.database}`;
      const boss = await startQueue(createQueue(url));
      try {
        const err = await db
          .transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE platform_api`);
            await tx.execute(sql`SELECT * FROM pgboss.job LIMIT 1`);
          })
          .then(() => null, (e: unknown) => e as { cause?: { message?: string } });
        expect(err?.cause?.message).toMatch(/permission denied/);
      } finally {
        await boss.stop({ graceful: false });
      }
    });
  }, 30000);
});
