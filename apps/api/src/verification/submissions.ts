import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { UPLOAD_RETENTION_MS, UPLOAD_TOKEN_TTL_MS, validateVerificationInput, type NetworkReputation, type VerificationInputError } from 'shared';
import type { Locale } from 'i18n';
import { withAccount, withSystem, type Db } from '../db/client.js';
import { studentVerifications, verificationUploads } from '../db/schema.js';
import { buildUploadUrl, generateUploadToken, hashUploadToken, isUploadTokenShape } from './upload-url.js';

export type StartError = VerificationInputError | 'network_blocked' | 'already_verified';

export interface StartResult {
  verificationId: string;
  uploadId: string;
  uploadUrl: string;
  expiresAt: Date;
}

/**
 * Starts (or continues) a student verification: validates the school details, refuses VPN / Tor, and issues a short-lived
 * one-shot token for the dedicated upload origin. No image data is involved here.
 */
export async function startVerification(
  db: Db,
  accountId: string,
  raw: Record<string, unknown> | null,
  deps: { network: NetworkReputation; ip: string; uploadOrigin: string; locale: Locale; now?: Date },
): Promise<{ ok: StartResult } | { error: StartError }> {
  const now = deps.now ?? new Date();
  const input = validateVerificationInput(raw, now);
  if ('error' in input) return input;
  const verdict = await deps.network.check(deps.ip);
  if (verdict.blocked) return { error: 'network_blocked' };

  return withAccount(db, accountId, async (tx) => {
    const rows = await tx.select().from(studentVerifications)
      .where(eq(studentVerifications.accountId, accountId)).orderBy(desc(studentVerifications.createdAt));
    if (rows.some((r) => r.status === 'approved' && r.validUntil && r.validUntil > now)) return { error: 'already_verified' as const };
    const pending = rows.find((r) => r.status === 'pending');
    const details = { schoolName: input.ok.schoolName, schoolKind: input.ok.schoolKind, expectedGraduationYear: input.ok.expectedGraduationYear };
    let verificationId: string;
    if (pending) {
      await tx.update(studentVerifications).set(details).where(eq(studentVerifications.id, pending.id));
      verificationId = pending.id;
    } else {
      const [created] = await tx.insert(studentVerifications).values({ accountId, ...details }).returning({ id: studentVerifications.id });
      verificationId = created!.id;
    }
    const uploadId = crypto.randomUUID();
    const token = generateUploadToken(uploadId, accountId);
    const expiresAt = new Date(now.getTime() + UPLOAD_TOKEN_TTL_MS);
    await tx.insert(verificationUploads).values({
      id: uploadId, verificationId, tokenHash: hashUploadToken(token), tokenExpiresAt: expiresAt,
      expiresAt: new Date(now.getTime() + UPLOAD_RETENTION_MS),
    });
    return { ok: { verificationId, uploadId, uploadUrl: buildUploadUrl(deps.uploadOrigin, deps.locale, token), expiresAt } };
  });
}

export interface ConsumedToken {
  uploadId: string;
  accountId: string;
  /** When the ciphertext must be deleted if nobody reviewed it (7 days after the submission). */
  expiresAt: Date;
}

/**
 * Called by the intake (never by browsers): atomically marks the token used and returns the ids it was issued for.
 * Expired, already used, unknown or malformed tokens all give null. The ids always come from the database row, never from
 * the request, so a token can only ever write the upload it was issued for.
 */
export async function consumeUploadToken(db: Db, token: unknown, now: Date = new Date()): Promise<ConsumedToken | null> {
  if (!isUploadTokenShape(token)) return null;
  return withSystem(db, async (tx) => {
    // A verification decided in the meantime accepts no more uploads, so the pending check is part of the same statement.
    const [row] = await tx.update(verificationUploads)
      .set({ tokenUsedAt: now, blobRef: sql`${verificationUploads.id}::text`, expiresAt: new Date(now.getTime() + UPLOAD_RETENTION_MS) })
      .where(and(
        eq(verificationUploads.tokenHash, hashUploadToken(token)),
        isNull(verificationUploads.tokenUsedAt),
        gt(verificationUploads.tokenExpiresAt, now),
        sql`exists (select 1 from ${studentVerifications} v where v.id = ${verificationUploads.verificationId} and v.status = 'pending')`,
      ))
      .returning({ uploadId: verificationUploads.id, verificationId: verificationUploads.verificationId, expiresAt: verificationUploads.expiresAt });
    if (!row) return null;
    const [v] = await tx.select({ accountId: studentVerifications.accountId }).from(studentVerifications).where(eq(studentVerifications.id, row.verificationId));
    return v ? { uploadId: row.uploadId, accountId: v.accountId, expiresAt: row.expiresAt } : null;
  });
}
