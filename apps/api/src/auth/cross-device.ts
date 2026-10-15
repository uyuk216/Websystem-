import { randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailChallenges } from '../db/schema.js';
import { hashesEqual, sha256Hex } from './email-login.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Tx = Pick<Db, 'select' | 'update'>;
type Row = typeof emailChallenges.$inferSelect;

const lock = async (tx: Tx, id: string): Promise<Row | undefined> => {
  const [c] = await tx.select().from(emailChallenges).where(eq(emailChallenges.id, id)).for('update');
  return c;
};
const fail = (tx: Tx, id: string) =>
  tx.update(emailChallenges).set({ crossDeviceState: 'failed', scanToken: null }).where(eq(emailChallenges.id, id));
const expired = (c: Row): boolean => c.expiresAt.getTime() <= Date.now();

/** Opening the mailed link. Login challenges only; the link token is single use. */
export async function openEmailLink(
  db: Db,
  challengeId: string,
  linkToken: string,
  openerDeviceId: string,
): Promise<{ result: 'logged_in'; accountId: string } | { result: 'cross_device_pending' } | { error: 'invalid' | 'expired' }> {
  if (!UUID.test(challengeId)) return { error: 'invalid' };
  return db.transaction(async (tx) => {
    const c = await lock(tx, challengeId);
    // crossDeviceState set means the link was already opened (or the challenge failed).
    if (!c || c.consumedAt || c.purpose !== 'login' || !c.accountId || c.crossDeviceState !== null) return { error: 'invalid' as const };
    if (!hashesEqual(c.linkTokenHash, sha256Hex(linkToken))) return { error: 'invalid' as const };
    if (expired(c)) return { error: 'expired' as const };
    if (openerDeviceId === c.requesterDeviceId) {
      await tx.update(emailChallenges).set({ consumedAt: new Date() }).where(eq(emailChallenges.id, c.id));
      return { result: 'logged_in' as const, accountId: c.accountId };
    }
    await tx.update(emailChallenges)
      .set({ crossDeviceState: 'awaiting_scan', crossDeviceNumber: randomInt(10, 100) })
      .where(eq(emailChallenges.id, c.id));
    return { result: 'cross_device_pending' as const };
  });
}

/**
 * Screen for the requesting device (polled every ~2s). The scan token is issued on the first awaiting_scan call
 * and stays stable for later polls, so the QR the phone already scanned keeps working. Only its plaintext is
 * stored (short-lived, cleared on approval/failure) since the QR must be re-displayable on every poll.
 */
export async function getRequesterScreen(
  db: Db,
  challengeId: string,
  requesterDeviceId: string,
  appOrigin: string,
): Promise<{ state: 'awaiting_scan'; qrPayload: string; number: number } | { state: 'approved' } | { state: 'none' }> {
  if (!UUID.test(challengeId)) return { state: 'none' };
  return db.transaction(async (tx) => {
    const c = await lock(tx, challengeId);
    if (!c || c.consumedAt || c.requesterDeviceId !== requesterDeviceId) return { state: 'none' as const };
    if (c.crossDeviceState !== 'awaiting_scan' && c.crossDeviceState !== 'approved') return { state: 'none' as const };
    if (expired(c)) {
      await fail(tx, c.id);
      return { state: 'none' as const };
    }
    if (c.crossDeviceState === 'approved') return { state: 'approved' as const };
    let token = c.scanToken;
    if (!token) {
      token = randomBytes(32).toString('base64url');
      await tx.update(emailChallenges).set({ scanToken: token }).where(eq(emailChallenges.id, c.id));
    }
    return {
      state: 'awaiting_scan' as const,
      qrPayload: `${appOrigin}/login/confirm?c=${c.id}&s=${token}`,
      number: c.crossDeviceNumber!,
    };
  });
}

const shuffle = <T>(a: T[]): T[] => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

/** Validates the scan token of an awaiting challenge; a wrong token or expiry kills the challenge. */
async function checkScan(tx: Tx, challengeId: string, scanToken: string): Promise<Row | null> {
  const c = await lock(tx, challengeId);
  if (!c || c.consumedAt || c.crossDeviceState !== 'awaiting_scan') return null;
  if (expired(c) || !c.scanToken || !hashesEqual(sha256Hex(c.scanToken), sha256Hex(scanToken))) {
    await fail(tx, c.id);
    return null;
  }
  return c;
}

/** For the confirming (already signed-in) device: the correct number plus two decoys, shuffled. */
export async function getConfirmChoices(
  db: Db,
  challengeId: string,
  scanToken: string,
): Promise<{ choices: [number, number, number]; requesterDevice: string; region: string | null } | { error: 'invalid' }> {
  if (!UUID.test(challengeId)) return { error: 'invalid' };
  return db.transaction(async (tx) => {
    const c = await checkScan(tx, challengeId, scanToken);
    if (!c) return { error: 'invalid' as const };
    const set = new Set<number>([c.crossDeviceNumber!]);
    while (set.size < 3) set.add(randomInt(10, 100));
    return {
      choices: shuffle([...set]) as [number, number, number],
      requesterDevice: c.requesterDeviceLabel ?? 'Unknown device',
      region: null, // no GeoIP in Phase 1
    };
  });
}

export async function confirmNumber(
  db: Db,
  challengeId: string,
  scanToken: string,
  chosen: number,
): Promise<{ ok: true } | { error: 'mismatch' | 'invalid' }> {
  if (!UUID.test(challengeId)) return { error: 'invalid' };
  return db.transaction(async (tx) => {
    const c = await checkScan(tx, challengeId, scanToken);
    if (!c) return { error: 'invalid' as const };
    if (chosen !== c.crossDeviceNumber) {
      await fail(tx, c.id);
      return { error: 'mismatch' as const };
    }
    await tx.update(emailChallenges)
      .set({ crossDeviceState: 'approved', approvedAt: new Date(), scanToken: null })
      .where(eq(emailChallenges.id, c.id));
    return { ok: true as const };
  });
}

/** Requester device collects the approved login (consumes the challenge). */
export async function completeCrossDeviceLogin(
  db: Db,
  challengeId: string,
  requesterDeviceId: string,
): Promise<{ accountId: string } | { error: 'invalid' }> {
  if (!UUID.test(challengeId)) return { error: 'invalid' };
  return db.transaction(async (tx) => {
    const c = await lock(tx, challengeId);
    if (!c || c.consumedAt || c.crossDeviceState !== 'approved' || !c.accountId) return { error: 'invalid' as const };
    if (c.requesterDeviceId !== requesterDeviceId || expired(c)) return { error: 'invalid' as const };
    await tx.update(emailChallenges).set({ consumedAt: new Date() }).where(eq(emailChallenges.id, c.id));
    return { accountId: c.accountId };
  });
}
