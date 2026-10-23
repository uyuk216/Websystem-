import { eq } from 'drizzle-orm';
import { withSystem, type Db, type Tx } from '../db/client.js';
import { platformSettings } from '../db/schema.js';

/** `platform_settings` の 1 つの値（なければ undefined）。システム側（owner ロール）で読む。 */
export async function readSetting(db: Db | Tx, key: string): Promise<unknown> {
  const [r] = await withSystem(db, (tx) => tx.select({ value: platformSettings.value }).from(platformSettings).where(eq(platformSettings.key, key)));
  return r?.value;
}
export async function readNumberSetting(db: Db | Tx, key: string, fallback: number): Promise<number> {
  const v = await readSetting(db, key);
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}
export async function readBoolSetting(db: Db | Tx, key: string, fallback: boolean): Promise<boolean> {
  const v = await readSetting(db, key);
  return typeof v === 'boolean' ? v : fallback;
}
