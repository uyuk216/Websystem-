import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createIdBlobStore } from '../../src/pii/store.js';
import { PII_BACKUP_EXCLUDE_MARKER } from '../../src/pii/schema.js';
import { withPiiTestDb, type PiiTestDb } from './helpers.js';

const put = (db: PiiTestDb, uploadId: string, accountId: string, bytes: Buffer, expires = "now() + interval '7 days'") =>
  db.ingest.unsafe(`INSERT INTO student_id_blobs (upload_id, account_id, ciphertext, size_bytes, expires_at) VALUES ($1, $2, $3, $4, ${expires})`, [uploadId, accountId, bytes, bytes.length]);

describe('IdBlobStore (pii_admin)', () => {
  it('finalizeReview records the review and deletes the ciphertext of every attempt in one transaction', () =>
    withPiiTestDb(async (db) => {
      const store = createIdBlobStore(db.admin);
      const acc = randomUUID();
      const [u1, u2] = [randomUUID(), randomUUID()];
      await put(db, u1, acc, Buffer.from([1]));
      await put(db, u2, acc, Buffer.from([2]));
      const n = await store.finalizeReview({ uploadId: u2, accountId: acc, operatorId: randomUUID(), result: 'approved', deleteUploadIds: [u1, u2] });
      expect(n).toBe(2);
      expect(await db.admin`SELECT 1 FROM student_id_blobs`).toHaveLength(0);
      const reviews = await db.admin`SELECT upload_id, result FROM verification_reviews`;
      expect(reviews.map((r) => [r.upload_id, r.result])).toEqual([[u2, 'approved']]);
    }));

  it('an approval without ciphertext throws and leaves no review record', () =>
    withPiiTestDb(async (db) => {
      const store = createIdBlobStore(db.admin);
      await expect(store.finalizeReview({ uploadId: randomUUID(), accountId: randomUUID(), operatorId: randomUUID(), result: 'approved', deleteUploadIds: [] })).rejects.toThrow();
      expect(await db.admin`SELECT 1 FROM verification_reviews`).toHaveLength(0);
    }));

  it('listBlobs returns metadata only, deleteBlobs removes by id', () =>
    withPiiTestDb(async (db) => {
      const store = createIdBlobStore(db.admin);
      const [u1, acc] = [randomUUID(), randomUUID()];
      await put(db, u1, acc, Buffer.from([9, 9]));
      const list = await store.listBlobs();
      expect(list).toHaveLength(1);
      expect(Object.keys(list[0]!).sort()).toEqual(['accountId', 'createdAt', 'expiresAt', 'uploadId']);
      expect(await store.deleteBlobs([])).toBe(0);
      expect(await store.deleteBlobs([u1])).toBe(1);
      expect(await store.listBlobs()).toHaveLength(0);
    }));
});

describe('backup exclusion (Review Focus 3)', () => {
  it('student_id_blobs carries the backup:exclude marker in the schema', () =>
    withPiiTestDb(async (db) => {
      const rows = await db.owner`SELECT c.relname FROM pg_class c JOIN pg_description d ON d.objoid = c.oid AND d.objsubid = 0
                                  WHERE d.description = ${PII_BACKUP_EXCLUDE_MARKER} AND c.relkind = 'r'`;
      expect(rows.map((r) => r.relname)).toEqual(['student_id_blobs']);
    }));

  it('a pg_dump made by dev/pii-backup.sh has the table definition but never the ciphertext', () =>
    withPiiTestDb(async (db) => {
      const marker = Buffer.from('SECRET-CIPHERTEXT-MARKER-0123456789');
      await put(db, randomUUID(), randomUUID(), marker);
      const name = (await db.owner`SELECT current_database() AS name`)[0]!.name as string;
      const script = fileURLToPath(new URL('../../../../dev/pii-backup.sh', import.meta.url));
      const dump = execFileSync('sh', [script, '-', String(name)], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
      expect(dump).toContain('CREATE TABLE public.student_id_blobs');
      expect(dump).toContain('CREATE TABLE public.verification_reviews');
      expect(dump).not.toContain('SECRET-CIPHERTEXT-MARKER');
      expect(dump).not.toContain(marker.toString('hex'));
      expect(dump).not.toMatch(/COPY public\.student_id_blobs[^\n]*\n[^\\]/);
      // 比較用: 除外なしのダンプにはデータが入る（この検査が空振りでないことの確認）。
      const full = execFileSync('docker', ['exec', 'ys-pii-db', 'pg_dump', '-U', 'pii_owner', '-d', String(name), '--no-owner', '--inserts'], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
      expect(full).toContain(marker.toString('hex'));
    }));
});
