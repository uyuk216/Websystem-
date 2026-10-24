import { createHash } from 'node:crypto';
import { GetObjectCommand, GetObjectRetentionCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';

/**
 * Object Lock（COMPLIANCE・versioning）の専用保管先の差し替え口。意図的に **削除・保持短縮・bypass・bucket 設定変更を持たない**
 * （一般の BucketStorage.delete* は渡さない）。本番の保管サービス・リージョン・保持期間・料金は未承認なので、既定は未導入。
 * 読む側（検証）は常に **最古の版** を正とする（同じ key に別の版を足されても元の版は残るため）。
 */
export interface AuditObjectRef { key: string; versionId: string; retainUntil: number; mode: 'COMPLIANCE' }
export interface AuditStorage {
  readonly installed: boolean;
  /** key が無ければ書く。同じ key に同じ digest が既にあれば既存の版を返す（再試行・応答喪失）。内容が違えば AuditConflictError。上書きしない。 */
  append(key: string, body: Uint8Array, digest: string, retainUntil: number): Promise<AuditObjectRef>;
  readVersion(key: string, versionId: string): Promise<Uint8Array | null>;
  verifyRetention(key: string, versionId: string): Promise<{ mode: string; retainUntil: number } | null>;
  /** 古い順の版 ID。 */
  versions(key: string): Promise<string[]>;
  /** prefix 配下の key（昇順）。 */
  list(prefix: string): Promise<string[]>;
}
export class AuditConflictError extends Error { constructor(key: string) { super(`audit object conflict: ${key}`); this.name = 'AuditConflictError'; } }
export class AuditStorageError extends Error { constructor(code: string) { super(code); this.name = 'AuditStorageError'; } }

const notInstalled = async (): Promise<never> => { throw new AuditStorageError('not_installed'); };
export const disabledAuditStorage: AuditStorage = {
  installed: false, append: notInstalled, readVersion: notInstalled, verifyRetention: notInstalled,
  versions: async () => [], list: async () => [],
};

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** テスト用の偽 Object Lock。通過は本番の不変性の実証ではない（版・保持・応答喪失の契約だけを確かめる）。 */
export class FakeWormStorage implements AuditStorage {
  readonly installed = true;
  private objects = new Map<string, { versionId: string; body: Uint8Array; digest: string; retainUntil: number; mode: string }[]>();
  private seq = 0;
  failNext = 0; // 次の n 回の呼び出しを失敗させる（S3 障害）
  loseResponseNext = 0; // 書き込み後に応答を失う
  constructor(private now: () => number = Date.now) {}
  private maybeFail(): void { if (this.failNext > 0) { this.failNext--; throw new AuditStorageError('unavailable'); } }
  async append(key: string, body: Uint8Array, digest: string, retainUntil: number): Promise<AuditObjectRef> {
    this.maybeFail();
    if (!Number.isFinite(retainUntil) || retainUntil <= this.now()) throw new AuditStorageError('retention_required');
    if (sha256Hex(body) !== digest) throw new AuditStorageError('digest_mismatch');
    const list = this.objects.get(key) ?? [];
    if (list.length > 0) {
      const first = list[0]!;
      if (first.digest !== digest) throw new AuditConflictError(key);
      return { key, versionId: first.versionId, retainUntil: first.retainUntil, mode: 'COMPLIANCE' };
    }
    const v = { versionId: `v${++this.seq}`, body: new Uint8Array(body), digest, retainUntil, mode: 'COMPLIANCE' };
    this.objects.set(key, [v]);
    if (this.loseResponseNext > 0) { this.loseResponseNext--; throw new AuditStorageError('response_lost'); }
    return { key, versionId: v.versionId, retainUntil, mode: 'COMPLIANCE' };
  }
  async readVersion(key: string, versionId: string): Promise<Uint8Array | null> {
    this.maybeFail();
    return this.objects.get(key)?.find((v) => v.versionId === versionId)?.body ?? null;
  }
  async verifyRetention(key: string, versionId: string) {
    this.maybeFail();
    const v = this.objects.get(key)?.find((o) => o.versionId === versionId);
    return v ? { mode: v.mode, retainUntil: v.retainUntil } : null;
  }
  async versions(key: string): Promise<string[]> { this.maybeFail(); return (this.objects.get(key) ?? []).map((v) => v.versionId); }
  async list(prefix: string): Promise<string[]> { this.maybeFail(); return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(); }
  /** テスト専用：別の書き手が同じ key に新しい版を足した状況（元の版は残る）。 */
  addVersionForTest(key: string, body: Uint8Array): void {
    const list = this.objects.get(key) ?? [];
    list.push({ versionId: `v${++this.seq}`, body, digest: sha256Hex(body), retainUntil: this.now() + 1e9, mode: 'COMPLIANCE' });
    this.objects.set(key, list);
  }
  /** テスト専用：保持なし・GOVERNANCE の版（検証が拒否するか）。 */
  setModeForTest(key: string, mode: string): void { for (const v of this.objects.get(key) ?? []) v.mode = mode; }
  /** テスト専用：DB 側ではなく保管先が書き換えられた想定は存在しない（版は不変）。ここは公開しない。 */
  keysForTest(): string[] { return [...this.objects.keys()]; }
}

/** 実装が使ってよい S3 command。Delete*・PutObjectRetention・PutBucket*・bypass 系は含まない。 */
export const AUDIT_S3_COMMANDS = ['PutObjectCommand', 'GetObjectCommand', 'GetObjectRetentionCommand', 'ListObjectVersionsCommand'] as const;
export interface AuditS3Client { send(command: unknown): Promise<unknown> }

/**
 * 実 S3 互換（Object Lock・versioning・COMPLIANCE を満たす専用 bucket）向けの adapter。クライアントは呼び出し側が注入する
 * （この関数は資格情報も bucket も作らない）。許可リスト外の command は送らない。
 */
export function s3AuditStorage(client: AuditS3Client, bucket: string): AuditStorage {
  const send = async <T>(command: { constructor: { name: string } }): Promise<T> => {
    if (!(AUDIT_S3_COMMANDS as readonly string[]).includes(command.constructor.name)) throw new AuditStorageError('command_not_allowed');
    return (await client.send(command)) as T;
  };
  const listVersions = async (prefix: string) => {
    const out: { key: string; versionId: string; at: number }[] = [];
    let keyMarker: string | undefined; let versionMarker: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const r = await send<{ Versions?: { Key?: string; VersionId?: string; LastModified?: Date }[]; IsTruncated?: boolean; NextKeyMarker?: string; NextVersionIdMarker?: string }>(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionMarker }));
      for (const v of r.Versions ?? []) if (v.Key && v.VersionId) out.push({ key: v.Key, versionId: v.VersionId, at: v.LastModified?.getTime() ?? 0 });
      if (!r.IsTruncated) break;
      keyMarker = r.NextKeyMarker; versionMarker = r.NextVersionIdMarker;
    }
    return out;
  };
  const versionsOf = async (key: string) => (await listVersions(key)).filter((v) => v.key === key).sort((a, b) => a.at - b.at).map((v) => v.versionId);
  const read = async (key: string, versionId: string): Promise<Uint8Array | null> => {
    try {
      const r = await send<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
      return r.Body ? await r.Body.transformToByteArray() : null;
    } catch (e) { if ((e as { name?: string }).name === 'NoSuchKey' || (e as { name?: string }).name === 'NoSuchVersion') return null; throw e; }
  };
  return {
    installed: true,
    async append(key, body, digest, retainUntil) {
      if (sha256Hex(body) !== digest) throw new AuditStorageError('digest_mismatch');
      if (!Number.isFinite(retainUntil) || retainUntil <= Date.now()) throw new AuditStorageError('retention_required');
      try {
        const r = await send<{ VersionId?: string }>(new PutObjectCommand({
          Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', IfNoneMatch: '*',
          ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'), ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil),
        }));
        if (!r.VersionId) throw new AuditStorageError('versioning_required');
        return { key, versionId: r.VersionId, retainUntil, mode: 'COMPLIANCE' };
      } catch (e) {
        const name = (e as { name?: string }).name;
        if (name !== 'PreconditionFailed' && (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw e;
        // 既にある：最古の版が同じ内容なら再試行として扱い、違えば衝突（上書きしない）。
        const first = (await versionsOf(key))[0];
        const existing = first ? await read(key, first) : null;
        if (!first || !existing || sha256Hex(existing) !== digest) throw new AuditConflictError(key);
        const ret = await this.verifyRetention(key, first);
        return { key, versionId: first, retainUntil: ret?.retainUntil ?? 0, mode: 'COMPLIANCE' };
      }
    },
    readVersion: read,
    async verifyRetention(key, versionId) {
      const r = await send<{ Retention?: { Mode?: string; RetainUntilDate?: Date } }>(new GetObjectRetentionCommand({ Bucket: bucket, Key: key, VersionId: versionId }));
      return r.Retention?.Mode && r.Retention.RetainUntilDate ? { mode: r.Retention.Mode, retainUntil: r.Retention.RetainUntilDate.getTime() } : null;
    },
    versions: versionsOf,
    async list(prefix) { return [...new Set((await listVersions(prefix)).map((v) => v.key))].sort(); },
  };
}
