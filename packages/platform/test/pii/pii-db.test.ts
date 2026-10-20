import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withPiiTestDb } from './helpers.js';

const blob = (uploadId = randomUUID()) => ({ uploadId, accountId: randomUUID(), bytes: Buffer.from([1, 2, 3, 4]) });

describe('PII database roles', () => {
  it('pii_ingest can append ciphertext but cannot read, update or delete anything', () =>
    withPiiTestDb(async ({ ingest, admin }) => {
      const b = blob();
      await ingest`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at)
                   VALUES (${b.uploadId}, ${b.accountId}, ${b.bytes}, ${b.bytes.length}, now() + interval '7 days')`;
      await expect(ingest`SELECT * FROM student_id_blobs`).rejects.toThrow(/permission denied/);
      await expect(ingest`SELECT count(*) FROM student_id_blobs`).rejects.toThrow(/permission denied/);
      await expect(ingest`UPDATE student_id_blobs SET size_bytes = 1`).rejects.toThrow(/permission denied/);
      await expect(ingest`DELETE FROM student_id_blobs`).rejects.toThrow(/permission denied/);
      await expect(ingest`SELECT * FROM verification_reviews`).rejects.toThrow(/permission denied/);
      await expect(ingest`INSERT INTO verification_reviews (upload_id, account_id, operator_id, result)
                          VALUES (${b.uploadId}, ${b.accountId}, ${randomUUID()}, 'approved')`).rejects.toThrow(/permission denied/);
      const rows = await admin`SELECT upload_id FROM student_id_blobs`;
      expect(rows.map((r) => r.upload_id)).toEqual([b.uploadId]);
    }));

  it('pii_ingest cannot create objects or change its own privileges', () =>
    withPiiTestDb(async ({ ingest }) => {
      await expect(ingest`CREATE TABLE leak (x int)`).rejects.toThrow(/permission denied/);
      // Without grant option the GRANT is a no-op (warning only); the privilege must still be absent afterwards.
      await ingest.unsafe('GRANT SELECT ON student_id_blobs TO pii_ingest').catch(() => undefined);
      await expect(ingest`SELECT 1 FROM student_id_blobs`).rejects.toThrow(/permission denied/);
    }));

  it('pii_admin reads and deletes ciphertext and appends reviews, but reviews cannot be altered', () =>
    withPiiTestDb(async ({ admin }) => {
      const op = randomUUID();
      const b = blob();
      await expect(admin`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at)
                         VALUES (${b.uploadId}, ${b.accountId}, ${b.bytes}, 4, now())`).rejects.toThrow(/permission denied/);
      await admin`INSERT INTO verification_reviews (upload_id, account_id, operator_id, result) VALUES (${b.uploadId}, ${b.accountId}, ${op}, 'approved')`;
      await expect(admin`INSERT INTO verification_reviews (upload_id, account_id, operator_id, result)
                         VALUES (${b.uploadId}, ${b.accountId}, ${op}, 'maybe')`).rejects.toThrow(/check constraint/);
      await expect(admin`UPDATE verification_reviews SET result = 'rejected'`).rejects.toThrow(/permission denied/);
      await expect(admin`DELETE FROM verification_reviews`).rejects.toThrow(/permission denied/);
      expect(await admin`SELECT * FROM verification_reviews`).toHaveLength(1);
    }));

  it('pii_admin can delete a blob (review done)', () =>
    withPiiTestDb(async ({ ingest, admin }) => {
      const b = blob();
      await ingest`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at) VALUES (${b.uploadId}, ${b.accountId}, ${b.bytes}, 4, now())`;
      await admin`DELETE FROM student_id_blobs WHERE upload_id = ${b.uploadId}`;
      expect(await admin`SELECT 1 FROM student_id_blobs`).toHaveLength(0);
    }));

  it('shares only account_id / upload_id uuids with the main database: no foreign keys', () =>
    withPiiTestDb(async ({ owner }) => {
      const fks = await owner`SELECT conname FROM pg_constraint WHERE contype = 'f'`;
      expect(fks).toHaveLength(0);
      const cols = await owner`SELECT table_name, column_name FROM information_schema.columns
                               WHERE table_schema = 'public' AND table_name IN ('student_id_blobs', 'verification_reviews')`;
      const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
      expect(names).toContain('student_id_blobs.upload_id');
      expect(names).toContain('student_id_blobs.account_id');
      expect(names.some((n) => /email|name|filename|exif/i.test(n))).toBe(false);
    }));
});
