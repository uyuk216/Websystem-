import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
  type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { accounts, passkeys, webauthnChallenges } from '../db/schema.js';
import { decryptEmail } from '../crypto/email.js';
import { UUID } from './cross-device.js';

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;
export interface PasskeyConfig {
  rpId: string;
  appOrigin: string;
  emailEncKey: Buffer;
}
const RP_NAME = 'Student PaaS';

async function issue(db: Db, kind: 'register' | 'login', accountId: string | null, challenge: string): Promise<string> {
  // webauthn_challenges is not reachable by platform_api: always the owner role.
  const [row] = await withSystem(db, (tx) => tx.insert(webauthnChallenges)
    .values({ accountId, kind, challenge, expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS) })
    .returning({ id: webauthnChallenges.id }));
  return row!.id;
}

/** One-time consume: atomically marks the challenge used (even if verification later fails). */
async function consume(db: Db, id: string, kind: 'register' | 'login', accountId: string | null): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const [row] = await withSystem(db, (tx) => tx.update(webauthnChallenges).set({ consumedAt: new Date() }).where(and(
    eq(webauthnChallenges.id, id), eq(webauthnChallenges.kind, kind), isNull(webauthnChallenges.consumedAt),
    gt(webauthnChallenges.expiresAt, new Date()),
    accountId === null ? isNull(webauthnChallenges.accountId) : eq(webauthnChallenges.accountId, accountId),
  )).returning({ challenge: webauthnChallenges.challenge }));
  return row?.challenge ?? null;
}

export async function startPasskeyRegistration(
  db: Db, accountId: string, cfg: PasskeyConfig,
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const [acct] = await withAccount(db, accountId, (tx) => tx.select({ emailEnc: accounts.emailEnc, displayName: accounts.displayName }).from(accounts).where(eq(accounts.id, accountId)));
  if (!acct) throw new Error('account not found');
  const existing = await withAccount(db, accountId, (tx) => tx.select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.accountId, accountId)));
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: cfg.rpId,
    userName: decryptEmail(acct.emailEnc, cfg.emailEncKey),
    userDisplayName: acct.displayName,
    userID: new TextEncoder().encode(accountId),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] })),
  });
  return { challengeId: await issue(db, 'register', accountId, options.challenge), options };
}

export async function finishPasskeyRegistration(
  db: Db, accountId: string, input: { challengeId: string; response: RegistrationResponseJSON }, cfg: PasskeyConfig,
): Promise<{ ok: true } | { error: 'invalid' }> {
  const challenge = await consume(db, input.challengeId, 'register', accountId);
  if (!challenge) return { error: 'invalid' };
  try {
    const v = await verifyRegistrationResponse({
      response: input.response, expectedChallenge: challenge, expectedOrigin: cfg.appOrigin, expectedRPID: cfg.rpId, requireUserVerification: true,
    });
    if (!v.verified) return { error: 'invalid' };
    const c = v.registrationInfo.credential;
    const rows = await withAccount(db, accountId, (tx) => tx.insert(passkeys).values({
      id: c.id, accountId, publicKey: Buffer.from(c.publicKey), counter: c.counter, transports: c.transports ?? [],
    }).onConflictDoNothing().returning({ id: passkeys.id }));
    return rows.length ? { ok: true } : { error: 'invalid' };
  } catch {
    return { error: 'invalid' };
  }
}

/** Discoverable-credential login: no account is named up front. */
export async function startPasskeyLogin(
  db: Db, cfg: PasskeyConfig,
): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({ rpID: cfg.rpId, userVerification: 'required' });
  return { challengeId: await issue(db, 'login', null, options.challenge), options };
}

export async function finishPasskeyLogin(
  db: Db, input: { challengeId: string; response: AuthenticationResponseJSON }, cfg: PasskeyConfig,
): Promise<{ accountId: string } | { error: 'invalid' }> {
  const challenge = await consume(db, input.challengeId, 'login', null);
  if (!challenge || typeof input.response?.id !== 'string') return { error: 'invalid' };
  // Pre-authentication: the credential id identifies the account, not the other way round.
  const [pk] = await withSystem(db, (tx) => tx.select().from(passkeys).where(eq(passkeys.id, input.response.id)));
  if (!pk) return { error: 'invalid' };
  try {
    const v = await verifyAuthenticationResponse({
      response: input.response, expectedChallenge: challenge, expectedOrigin: cfg.appOrigin, expectedRPID: cfg.rpId, requireUserVerification: true,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.publicKey), counter: pk.counter, transports: pk.transports as AuthenticatorTransport[] },
    });
    if (!v.verified) return { error: 'invalid' };
    const next = v.authenticationInfo.newCounter;
    // Compare-and-set on the counter; a counter that did not advance (clone/rollback) is rejected unless both are 0.
    if (next <= pk.counter && !(next === 0 && pk.counter === 0)) return { error: 'invalid' };
    const rows = await withSystem(db, (tx) => tx.update(passkeys).set({ counter: next, lastUsedAt: new Date() })
      .where(and(eq(passkeys.id, pk.id), eq(passkeys.counter, pk.counter))).returning({ id: passkeys.id }));
    return rows.length ? { accountId: pk.accountId } : { error: 'invalid' };
  } catch {
    return { error: 'invalid' };
  }
}

/** Deletes expired or consumed WebAuthn challenges. Returns the number of rows removed. */
export async function purgeWebauthnChallenges(db: Db, now: Date): Promise<number> {
  const rows = await withSystem(db, (tx) => tx.delete(webauthnChallenges)
    .where(or(lt(webauthnChallenges.expiresAt, now), isNotNull(webauthnChallenges.consumedAt)))
    .returning({ id: webauthnChallenges.id }));
  return rows.length;
}
