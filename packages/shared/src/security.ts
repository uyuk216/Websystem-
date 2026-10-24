/**
 * フェーズ 6 Task 1: セキュリティ事件の共通の型と、副作用のない規則。DB を触る入口は
 * `apps/api/src/security/incidents.ts` の `handleSecuritySignal` だけ。
 *
 * 重大度ごとの対処（IP / アプリ / アカウントの範囲は混同しない）:
 *   高 = アプリ遮断 + コンテナ停止 + 運営通知、中 = アプリ遮断 + 運営通知、低 = 運営通知のみ。
 */

export const SIGNAL_SOURCES = ['falco', 'cpu', 'egress', 'phishing', 'file_distribution', 'honeytoken', 'vpn', 'manual'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];
const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
export const severityRank = (s: Severity): number => RANK[s];
export const maxSeverity = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b);

export const TARGET_KINDS = ['app', 'account', 'ip'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** 信頼できる対象。送信者が名乗った app / owner はそのまま信じず、API 側が実際の記録と照合する。 */
export type SecurityTarget =
  | { kind: 'app'; appId: string; /** 送信者が主張するオーナー。実際の持ち主と違えば拒否する。 */ ownerId?: string }
  | { kind: 'account'; accountId: string }
  /** 生の IP は持たない。秘密鍵による HMAC（IPv4 / IPv6 正規化後）の 64 桁 16 進。 */
  | { kind: 'ip'; ipHash: string };

export interface SecuritySignal {
  source: SignalSource;
  /** 検知器側の一意な事件キー。(source, sourceEventId) で重複を排除する。 */
  sourceEventId: string;
  ruleVersion: string;
  occurredAt: Date;
  severity: Severity;
  target: SecurityTarget;
  /** 小文字・英数字・`_` `.` `-` の理由コード。 */
  reasonCode: string;
  /** 許可リストのキーだけ。`evidenceDigest` はこの正規化 JSON の SHA-256。 */
  evidence: Record<string, string | number | boolean>;
  evidenceDigest: string;
}

export interface Plan {
  /** その対象に有効なブロック理由を作る。 */
  block: boolean;
  /** 対象がアプリなら動的アプリのコンテナを止める。 */
  stopContainer: boolean;
  notifyOperator: boolean;
}

export function planFor(severity: Severity, targetKind: TargetKind): Plan {
  const notifyOperator = true;
  if (severity === 'low') return { block: false, stopContainer: false, notifyOperator };
  return { block: true, stopContainer: severity === 'high' && targetKind === 'app', notifyOperator };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const IP_HASH_RE = /^[0-9a-f]{64}$/;
export const REASON_CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const RULE_VERSION_RE = /^[A-Za-z0-9_.+-]{1,32}$/;

/** 事件に保存してよい証拠のキー。本文・環境変数・認証情報・生の IP・クエリ付き URL を入れる場所は無い。 */
export const EVIDENCE_KEYS = [
  'rule', 'container', 'syscall', 'metric', 'value', 'threshold', 'windowSeconds', 'count', 'verdict', 'category',
  'tokenKind', 'pathHash', 'urlHash', 'domainHash', 'fileHash', 'asnClass', 'note',
] as const;
const EVIDENCE_KEY_SET: ReadonlySet<string> = new Set(EVIDENCE_KEYS);
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const IPV6_RE = /(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}/i;
const EVIDENCE_TEXT_RE = /^[A-Za-z0-9_.:@/ +=-]{0,128}$/;

export type SignalError =
  | 'bad_source' | 'bad_event_id' | 'bad_rule_version' | 'bad_time' | 'bad_severity' | 'bad_target' | 'bad_reason'
  | 'bad_evidence_key' | 'bad_evidence_value' | 'bad_digest';

/** 形だけの検証（DB は見ない）。証拠のダイジェストの照合は API 側（SHA-256 が要る）。 */
export function validateSignalShape(s: SecuritySignal): SignalError | null {
  if (!SIGNAL_SOURCES.includes(s.source)) return 'bad_source';
  if (!EVENT_ID_RE.test(s.sourceEventId)) return 'bad_event_id';
  if (!RULE_VERSION_RE.test(s.ruleVersion)) return 'bad_rule_version';
  if (!(s.occurredAt instanceof Date) || Number.isNaN(s.occurredAt.getTime())) return 'bad_time';
  if (!SEVERITIES.includes(s.severity)) return 'bad_severity';
  if (!REASON_CODE_RE.test(s.reasonCode)) return 'bad_reason';
  const t = s.target;
  if (t.kind === 'app') { if (!UUID_RE.test(t.appId) || (t.ownerId !== undefined && !UUID_RE.test(t.ownerId))) return 'bad_target'; }
  else if (t.kind === 'account') { if (!UUID_RE.test(t.accountId)) return 'bad_target'; }
  else if (t.kind === 'ip') { if (!IP_HASH_RE.test(t.ipHash)) return 'bad_target'; }
  else return 'bad_target';
  const keys = Object.keys(s.evidence);
  if (keys.length > 16) return 'bad_evidence_key';
  for (const k of keys) {
    if (!EVIDENCE_KEY_SET.has(k)) return 'bad_evidence_key';
    const v = s.evidence[k];
    if (typeof v === 'number') { if (!Number.isFinite(v)) return 'bad_evidence_value'; }
    else if (typeof v === 'string') { if (!EVIDENCE_TEXT_RE.test(v) || IPV4_RE.test(v) || IPV6_RE.test(v)) return 'bad_evidence_value'; }
    else if (typeof v !== 'boolean') return 'bad_evidence_value';
  }
  if (!/^[0-9a-f]{64}$/.test(s.evidenceDigest)) return 'bad_digest';
  return null;
}

/** ダイジェスト計算用の正規化 JSON（キーを辞書順に並べる）。 */
export function canonicalEvidence(e: Record<string, string | number | boolean>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(e).sort().map((k) => [k, e[k]])));
}
