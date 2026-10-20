import { grantStudent } from '../../src/grants/grants.js';
import type { TestDb } from './db.js';

/** テスト用: アカウントに Student の付与を作る（既定は 2020 年から 2100 年まで。時計を動かすテストでも有効）。付与がないと動的アプリは動かせない。 */
export async function giveStudent(db: TestDb, accountId: string, endsAt: Date = new Date('2100-03-31T14:59:59Z')): Promise<void> {
  await grantStudent(db as never, accountId, endsAt, { reason: 'test fixture', startsAt: new Date('2020-01-01T00:00:00Z') });
}
