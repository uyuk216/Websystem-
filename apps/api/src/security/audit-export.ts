import { createHash } from 'node:crypto';

/**
 * WORM（Object Lock）へ送る監査バッチの形と、秘密値が混ざらないことの検査。DB にも保管先にも触らない純粋な部分。
 * バッチは stream ID・連番範囲・前バッチ digest・各行の元 hash・匿名化 payload の digest・版を持つ。
 */
export const AUDIT_STREAMS = ['security', 'admin'] as const;
export type AuditStream = (typeof AUDIT_STREAMS)[number];
export const BATCH_VERSION = 1;
export const pad = (n: number): string => String(n).padStart(12, '0');
export const batchKey = (stream: AuditStream, from: number, to: number): string => `${stream}/batches/${pad(from)}-${pad(to)}.json`;
export const checkpointKey = (stream: AuditStream, to: number): string => `${stream}/checkpoints/${pad(to)}.json`;
export const GENESIS = '0'.repeat(64);

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
export const sha256 = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

export interface BatchRow { seq: number; hash: string; prevHash: string; incidentRef: string; action: string; at: string; payloadDigest: string; originalDigest?: string; piiFlag?: boolean; reasonCode?: string }
export interface AuditBatch { version: number; stream: AuditStream; fromSeq: number; toSeq: number; prevBatchDigest: string; rows: BatchRow[] }
export interface Checkpoint { version: number; stream: AuditStream; headSeq: number; headHash: string; batchKey: string; batchDigest: string; batchVersion: string; at: string }

// メール・IPv4・IPv6・URL・クエリ・Bearer・長い連続文字列（64 桁 16 進の digest は許可）。
const SECRET_PATTERNS = [/@/, /\b\d{1,3}(?:\.\d{1,3}){3}\b/, /(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}/i, /:\/\//, /\?/, /bearer\s/i, /(?:password|secret|token)\s*[=:]/i];
export function looksSensitive(s: string): boolean {
  if (/^[0-9a-f]{64}$/.test(s)) return false;
  return s.length > 128 || SECRET_PATTERNS.some((p) => p.test(s));
}
export class UnsafeAuditPayload extends Error { constructor() { super('unsafe_audit_payload'); this.name = 'UnsafeAuditPayload'; } }
/** WORM に載せる値（コード・数値・digest）だけ許す。入れ子・長い文字列・メール/IP/URL らしいものは拒否。 */
export function assertWormSafe(detail: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(detail)) {
    if (looksSensitive(k)) throw new UnsafeAuditPayload();
    if (typeof v === 'string') { if (looksSensitive(v)) throw new UnsafeAuditPayload(); }
    else if (typeof v !== 'number' && typeof v !== 'boolean') throw new UnsafeAuditPayload();
  }
}

export interface SystemAuditRow { seq: number; hash: string; prevHash: string; incidentId: string; action: string; detail: Record<string, unknown>; createdAt: Date }
/** 秘密らしい値は載せずに 'redacted' へ置き換える（配送を止めない）。置き換えた行は piiFlag を立てる。 */
export function sanitizeDetail(detail: Record<string, unknown>): { detail: Record<string, string | number | boolean>; redacted: boolean } {
  const out: Record<string, string | number | boolean> = {}; let redacted = false;
  for (const [k, v] of Object.entries(detail)) {
    if (looksSensitive(k)) { redacted = true; continue; }
    if ((typeof v === 'string' && !looksSensitive(v)) || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else { out[k] = 'redacted'; redacted = true; }
  }
  return { detail: out, redacted };
}
export function systemBatchRow(r: SystemAuditRow): BatchRow {
  const { detail, redacted } = sanitizeDetail(r.detail);
  const action = /^[a-z0-9_.:-]{1,64}$/.test(r.action) && !looksSensitive(r.action) ? r.action : 'redacted';
  const at = r.createdAt.toISOString();
  return { seq: r.seq, hash: r.hash, prevHash: r.prevHash, incidentRef: r.incidentId, action, at, payloadDigest: sha256(canonicalJson({ incident: r.incidentId, action, detail, at })), ...(typeof detail.reasonCode === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(detail.reasonCode) ? { reasonCode: detail.reasonCode } : {}), ...(redacted || action === 'redacted' ? { piiFlag: true } : {}) };
}

/** 旧管理記録の匿名化 export。メール・対象・detail 全文は載せず、原本の digest と匿名化 payload を対応付ける。PII らしい内容は piiFlag だけ立てる。 */
export interface AdminAuditRow { seq: number; hash: string; prevHash: string; operatorId: string; action: string; target: string; detail: Record<string, unknown>; createdAt: Date }
export function adminBatchRow(r: AdminAuditRow): BatchRow {
  const original = canonicalJson({ seq: r.seq, operator: r.operatorId, action: r.action, target: r.target, detail: r.detail, at: r.createdAt.toISOString() });
  const containsPii = looksSensitive(r.target) || looksSensitive(JSON.stringify(r.detail)) || looksSensitive(r.action);
  const action = /^[a-z0-9_.:-]{1,64}$/.test(r.action) && !looksSensitive(r.action) ? r.action : 'redacted';
  const at = r.createdAt.toISOString();
  const targetKind = /^([a-z_]{1,24}):/.exec(r.target)?.[1] ?? 'other'; // 例 "app:<id>" の種別だけ。ID・メールは載せない
  return {
    seq: r.seq, hash: r.hash, prevHash: r.prevHash, incidentRef: sha256(`op:${r.operatorId}`).slice(0, 16), action, at,
    payloadDigest: sha256(canonicalJson({ action, targetKind, detailDigest: sha256(canonicalJson(r.detail)), at })), originalDigest: sha256(original), piiFlag: containsPii,
  };
}

export function buildBatch(stream: AuditStream, rows: BatchRow[], prevBatchDigest: string): { batch: AuditBatch; body: Uint8Array; digest: string; key: string } {
  if (rows.length === 0) throw new Error('empty_batch');
  for (let i = 1; i < rows.length; i++) if (rows[i]!.seq !== rows[i - 1]!.seq + 1) throw new Error('audit_gap');
  const batch: AuditBatch = { version: BATCH_VERSION, stream, fromSeq: rows[0]!.seq, toSeq: rows.at(-1)!.seq, prevBatchDigest, rows };
  const body = new TextEncoder().encode(canonicalJson(batch));
  return { batch, body, digest: sha256(body), key: batchKey(stream, batch.fromSeq, batch.toSeq) };
}
export function buildCheckpoint(batch: AuditBatch, key: string, digest: string, versionId: string, at: Date): { body: Uint8Array; digest: string; key: string; checkpoint: Checkpoint } {
  const last = batch.rows.at(-1)!;
  const checkpoint: Checkpoint = { version: BATCH_VERSION, stream: batch.stream, headSeq: last.seq, headHash: last.hash, batchKey: key, batchDigest: digest, batchVersion: versionId, at: at.toISOString() };
  const body = new TextEncoder().encode(canonicalJson(checkpoint));
  return { body, digest: sha256(body), key: checkpointKey(batch.stream, last.seq), checkpoint };
}
export const parseJson = <T>(b: Uint8Array): T => JSON.parse(new TextDecoder().decode(b)) as T;
