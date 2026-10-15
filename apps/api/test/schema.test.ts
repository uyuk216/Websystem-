import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withTestDb } from './helpers/db.js';
import { owners, accounts } from '../src/db/schema.js';

describe('schema', () => {
  it('owners CHECK allows exactly one matching ref', () =>
    withTestDb(async (db) => {
      const [a] = await db.insert(accounts).values({ emailHash: 'h', emailEnc: 'e', displayName: 'n', locale: 'ja', adultFrom: '2030-01-01' }).returning();
      await db.insert(owners).values({ kind: 'account', accountId: a!.id });
      await expect(db.insert(owners).values({ kind: 'account' })).rejects.toThrow();
      await expect(db.insert(owners).values({ kind: 'team', accountId: a!.id })).rejects.toThrow();
      await expect(db.execute(sql`select 1`)).resolves.toBeTruthy();
    }));
});
