import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { appEnvVars, apps } from '../db/schema.js';
import { mayManage } from './apps.js';

export const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_VALUE_BYTES = 32 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024;
export const MAX_VARS = 100;

const IV_LEN = 12;
const TAG_LEN = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isReservedEnvName = (name: string): boolean => name === 'PORT' || name === 'HOST' || name.startsWith('YS_');

/** Associated data binds a ciphertext to its app and name so rows cannot be swapped. */
const aad = (appId: string, name: string) => Buffer.from(`${appId}\0${name}`, 'utf8');

export function encryptEnvValue(value: string, key: Buffer, appId: string, name: string): string {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  c.setAAD(aad(appId, name));
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptEnvValue(blob: string, key: Buffer, appId: string, name: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('invalid ciphertext');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_LEN), { authTagLength: TAG_LEN });
  d.setAAD(aad(appId, name));
  d.setAuthTag(buf.subarray(IV_LEN, IV_LEN + TAG_LEN));
  return Buffer.concat([d.update(buf.subarray(IV_LEN + TAG_LEN)), d.final()]).toString('utf8');
}

export type EnvError = 'not_found' | 'forbidden' | 'invalid_name' | 'reserved' | 'invalid_value' | 'too_large' | 'limit';

export function validateEnv(name: string, value: string): EnvError | null {
  if (!ENV_NAME.test(name)) return 'invalid_name';
  if (isReservedEnvName(name)) return 'reserved';
  if (/[\r\n\0]/.test(value)) return 'invalid_value';
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return 'too_large';
  return null;
}

export interface EnvVarView { name: string; updatedAt: Date }

/** Names and timestamps only; values never leave the server except to the runner. */
export async function listEnvVars(db: Db, accountId: string, appId: string): Promise<EnvVarView[] | { error: 'not_found' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    return tx.select({ name: appEnvVars.name, updatedAt: appEnvVars.updatedAt }).from(appEnvVars)
      .where(eq(appEnvVars.appId, appId)).orderBy(asc(appEnvVars.name));
  });
}

export async function setEnvVar(db: Db, key: Buffer, accountId: string, appId: string, name: string, value: string): Promise<{ ok: true } | { error: EnvError }> {
  const bad = validateEnv(name, value);
  if (bad) return { error: bad };
  if (!UUID.test(appId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    // Serialize concurrent writers per app so the total-size cap holds.
    await tx.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).for('update');
    const rows = await tx.select({ name: appEnvVars.name, valueEnc: appEnvVars.valueEnc }).from(appEnvVars).where(eq(appEnvVars.appId, appId));
    let total = Buffer.byteLength(value, 'utf8') + name.length;
    let count = 1;
    for (const r of rows) {
      if (r.name === name) continue;
      count++;
      total += r.name.length + Buffer.byteLength(decryptEnvValue(r.valueEnc, key, appId, r.name), 'utf8');
    }
    if (count > MAX_VARS) return { error: 'limit' as const };
    if (total > MAX_TOTAL_BYTES) return { error: 'too_large' as const };
    const valueEnc = encryptEnvValue(value, key, appId, name);
    await tx.insert(appEnvVars).values({ appId, name, valueEnc })
      .onConflictDoUpdate({ target: [appEnvVars.appId, appEnvVars.name], set: { valueEnc, updatedAt: new Date() } });
    return { ok: true as const };
  });
}

export async function deleteEnvVar(db: Db, accountId: string, appId: string, name: string): Promise<{ ok: true } | { error: 'not_found' | 'forbidden' }> {
  if (!UUID.test(appId)) return { error: 'not_found' };
  return withAccount(db, accountId, async (tx) => {
    const [a] = await tx.select({ ownerId: apps.ownerId }).from(apps).where(eq(apps.id, appId));
    if (!a) return { error: 'not_found' as const };
    if (!(await mayManage(tx, accountId, a.ownerId))) return { error: 'forbidden' as const };
    const rows = await tx.delete(appEnvVars).where(and(eq(appEnvVars.appId, appId), eq(appEnvVars.name, name))).returning({ name: appEnvVars.name });
    return rows.length ? { ok: true as const } : { error: 'not_found' as const };
  });
}

/** For the worker when launching an app: decrypted name -> value map. */
export async function getAppEnvForRun(db: Db, key: Buffer, appId: string): Promise<Record<string, string>> {
  const rows = await withSystem(db, (tx) => tx.select({ name: appEnvVars.name, valueEnc: appEnvVars.valueEnc }).from(appEnvVars).where(eq(appEnvVars.appId, appId)));
  return Object.fromEntries(rows.map((r) => [r.name, decryptEnvValue(r.valueEnc, key, appId, r.name)]));
}
