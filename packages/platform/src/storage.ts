import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';

export const BUCKETS = { sources: 'sources', sites: 'sites' } as const;
export type BucketName = (typeof BUCKETS)[keyof typeof BUCKETS];

export interface StorageConfig {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const req = (n: string): string => {
    const v = env[n];
    if (!v) throw new Error(`Missing required env var: ${n}`);
    return v;
  };
  return {
    endpoint: req('S3_ENDPOINT'),
    accessKey: req('S3_ACCESS_KEY'),
    secretKey: req('S3_SECRET_KEY'),
    region: env.S3_REGION || 'us-east-1',
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Key prefix holding all of an app's objects in a bucket. Always ends with "/". */
export function appPrefix(bucket: BucketName, appId: string): string {
  if (!Object.values(BUCKETS).includes(bucket)) throw new Error(`unknown bucket: ${bucket}`);
  if (!UUID_RE.test(appId)) throw new Error('appId must be a UUID');
  return `${appId}/`;
}

export interface ObjectHead {
  size: number;
  contentType: string | undefined;
}
export interface StoredObject extends ObjectHead {
  body: Readable;
}
export interface ListedObject {
  key: string;
  size: number;
}

/** Bucket-scoped view of the object store. */
export interface BucketStorage {
  put(key: string, body: Buffer | Uint8Array | string | Readable, contentType?: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<ObjectHead | null>;
  list(prefix: string): Promise<ListedObject[]>;
  /** Deletes one object (no error when it does not exist). */
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}

export interface Storage {
  sources: BucketStorage;
  sites: BucketStorage;
  /** Creates the `sources` and `sites` buckets if missing (idempotent). */
  ensureBuckets(): Promise<void>;
  close(): void;
}

function isNotFound(e: unknown): boolean {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  // Object-level misses only. NoSuchBucket (also a 404) must surface as an error.
  return x?.name === 'NoSuchKey' || x?.name === 'NotFound';
}

function bucketStorage(s3: S3Client, Bucket: string): BucketStorage {
  return {
    async put(Key, body, contentType) {
      // Multipart, streaming upload (handles Buffers, strings and streams of unknown length).
      await new Upload({ client: s3, params: { Bucket, Key, Body: body, ContentType: contentType } }).done();
    },
    async get(Key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
        return { body: r.Body as Readable, size: r.ContentLength ?? 0, contentType: r.ContentType };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async head(Key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket, Key }));
        return { size: r.ContentLength ?? 0, contentType: r.ContentType };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async list(Prefix) {
      const out: ListedObject[] = [];
      let ContinuationToken: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
        ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    async delete(Key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key }));
    },
    async deletePrefix(prefix) {
      if (!prefix.endsWith('/')) throw new Error('deletePrefix requires a prefix ending with "/"');
      let n = 0;
      for (;;) {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, MaxKeys: 1000 }));
        const keys = (r.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length === 0) return n;
        const d = await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
        if (d.Errors?.length) throw new Error(`deletePrefix failed: ${d.Errors[0]?.Message ?? d.Errors[0]?.Code}`);
        n += keys.length;
      }
    },
  };
}

export function createStorage(cfg: StorageConfig): Storage {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
  return {
    sources: bucketStorage(s3, BUCKETS.sources),
    sites: bucketStorage(s3, BUCKETS.sites),
    async ensureBuckets() {
      for (const Bucket of Object.values(BUCKETS)) {
        try {
          await s3.send(new HeadBucketCommand({ Bucket }));
        } catch (e) {
          if (!isNotFound(e)) throw e;
          try {
            await s3.send(new CreateBucketCommand({ Bucket }));
          } catch (e2) {
            const n = (e2 as { name?: string }).name;
            if (n !== 'BucketAlreadyOwnedByYou' && n !== 'BucketAlreadyExists') throw e2;
          }
        }
      }
    },
    close: () => s3.destroy(),
  };
}
