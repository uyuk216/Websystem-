/**
 * フェーズ 6 の運用設定と「防御完了」の判定（DB を読まない純粋関数）。
 * 設定値は既知キーだけを受け付け、負数・0・無制限・極端に緩い値を拒否する。
 */
export type DetectorMode = 'test' | 'observe' | 'enforce';
export const DETECTOR_MODES: readonly DetectorMode[] = ['test', 'observe', 'enforce'];

/** 検知・基盤の部品。doctor / status はこの単位で個別に報告する。 */
export const SECURITY_PARTS = ['audit_worm', 'edge_gate', 'recovery', 'falco', 'metrics_proxy', 'network_data', 'honeytokens', 'db_audit', 'safe_browsing'] as const;
export type SecurityPart = (typeof SECURITY_PARTS)[number];

interface IntSpec { kind: 'int' | 'float'; min: number; max: number; default: number; doc: string }
interface ModeSpec { kind: 'mode'; default: DetectorMode; doc: string }
interface StringSpec { kind: 'email'; default: string; doc: string }
interface CidrSpec { kind: 'cidrs'; default: string[]; max: number; doc: string }
export type SecuritySettingSpec = IntSpec | ModeSpec | StringSpec | CidrSpec;

const int = (min: number, max: number, def: number, doc: string): IntSpec => ({ kind: 'int', min, max, default: def, doc });
export const SECURITY_SETTING_SPECS: Readonly<Record<string, SecuritySettingSpec>> = {
  'security.window_ms': int(10_000, 3_600_000, 60_000, '集計する時間窓（ミリ秒）'),
  'security.min_samples': int(2, 100, 3, '時間窓で必要な最小サンプル数'),
  'security.max_gap_ms': int(1_000, 3_600_000, 30_000, 'サンプル間の許容する欠け（時間窓以下）'),
  'security.threshold.cpu': { kind: 'float', min: 0.1, max: 1, default: 0.8, doc: 'CPU の通知しきい値（1 = 100%）。CPU だけでは通知のみ' },
  'security.threshold.egress_bytes': int(1_048_576, 107_374_182_400, 104_857_600, '時間窓あたりの外向き通信量（バイト）'),
  'security.threshold.connections': int(10, 100_000, 1000, '同時接続数のしきい値'),
  'security.threshold.served_bytes': int(1_048_576, 1_099_511_627_776, 104_857_600, '時間窓あたりの配信量（バイト）'),
  'security.scan.window_ms': int(10_000, 3_600_000, 300_000, '罠パスの走査検知の時間窓'),
  'security.scan.threshold': int(2, 1000, 5, '時間窓内に同じ IP が罠パスに触れた回数のしきい値'),
  'security.network.max_age_hours': int(1, 720, 168, 'IP データの更新期限。超えると unknown 扱い（保護対象は 503）'),
  'security.network.exceptions': { kind: 'cidrs', default: [], max: 500, doc: '例外 CIDR（学校など）。VPN 判定だけに効き、罠・攻撃 IP のブロックには効かない' },
  'security.audit.max_delivery_delay_s': int(30, 86_400, 300, '監査の WORM 配送遅延の許容（秒）。超えると運営者へ警告し、公開・巻き戻しを保留'),
  'security.outbox.capacity': int(100, 1_000_000, 10_000, '未配送 outbox の許容件数。超えると警告'),
  'security.notify.operator_to': { kind: 'email', default: '', doc: '運営者への通知先メールアドレス' },
  ...Object.fromEntries(['falco', 'metrics_proxy', 'network', 'honeytokens', 'safe_browsing'].map((d) =>
    [`security.detector.${d}.mode`, { kind: 'mode', default: 'observe', doc: `${d} の運用モード（test / observe / enforce）` } satisfies ModeSpec])),
};

export const isSecuritySettingKey = (k: string): boolean => Object.hasOwn(SECURITY_SETTING_SPECS, k);

const CIDR_RE = /^(?:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})|([0-9a-f:]+)\/(\d{1,3}))$/i;
function validCidr(s: unknown): boolean {
  if (typeof s !== 'string' || s.length > 64) return false;
  const m = CIDR_RE.exec(s);
  if (!m) return false;
  if (m[1] !== undefined) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    const bits = Number(m[5]);
    return octets.every((o) => o <= 255) && bits >= 8 && bits <= 32; // /0〜/7 は「全部通す」に近いので拒否
  }
  const bits = Number(m[7]);
  return m[6]!.includes(':') && bits >= 16 && bits <= 128;
}

export type SettingCheck = { ok: true } | { ok: false; error: 'unknown_key' | 'invalid_value' | 'too_permissive_in_production' };
/** `security.*` の設定を検証する。production では test モードを拒否する。 */
export function validateSecuritySetting(key: string, value: unknown, opts: { production?: boolean } = {}): SettingCheck {
  const spec = SECURITY_SETTING_SPECS[key];
  if (!spec || !Object.hasOwn(SECURITY_SETTING_SPECS, key)) return { ok: false, error: 'unknown_key' };
  const bad: SettingCheck = { ok: false, error: 'invalid_value' };
  switch (spec.kind) {
    case 'int': case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max) return bad;
      return spec.kind === 'int' && !Number.isInteger(value) ? bad : { ok: true };
    case 'mode':
      if (!DETECTOR_MODES.includes(value as DetectorMode)) return bad;
      return opts.production && value === 'test' ? { ok: false, error: 'too_permissive_in_production' } : { ok: true };
    case 'email':
      return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { ok: true } : bad;
    case 'cidrs':
      return Array.isArray(value) && value.length <= spec.max && value.every(validCidr) ? { ok: true } : bad;
  }
}

/** 保存済みの値と既定値を合わせる。不正な値は無視して既定値に戻す（無制限や 0 にはならない）。 */
export function resolveSecuritySettings(stored: Record<string, unknown>, opts: { production?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(SECURITY_SETTING_SPECS)) {
    out[k] = Object.hasOwn(stored, k) && validateSecuritySetting(k, stored[k], opts).ok ? stored[k] : spec.default;
  }
  return out;
}

// ---- 防御完了の判定 ----
export type PartState = 'not_installed' | 'installed' | 'expired' | 'undelivered' | 'unknown';
export interface PartReport { part: SecurityPart; state: PartState; mode: DetectorMode | 'unset' | 'unknown'; note: string }
export type PartInput = { state: PartState; mode?: string | undefined };

const NOTE: Record<PartState, string> = {
  not_installed: '未導入（取得・承認前）。この部品は動いていない',
  installed: '導入済み',
  expired: 'データの更新期限が切れている（保護対象の操作は 503）',
  undelivered: '未配送が残っている（公開・巻き戻しを保留）',
  unknown: '状態を確認できない',
};
const parseMode = (m: string | undefined): PartReport['mode'] => (m === undefined || m === '' ? 'unset' : DETECTOR_MODES.includes(m as DetectorMode) ? (m as DetectorMode) : 'unknown');

/**
 * 全部品を個別に報告する。complete は「全部品が導入済みで enforce」のときだけ true。
 * 未設定・未知・observe・test が 1 つでもあれば本番防御完了と表示しない。
 */
export function assessProductionDefense(input: Partial<Record<SecurityPart, PartInput>>): { complete: boolean; parts: PartReport[]; blockers: SecurityPart[] } {
  const parts = SECURITY_PARTS.map((part): PartReport => {
    const i = input[part] ?? { state: 'unknown' as const };
    return { part, state: i.state, mode: parseMode(i.mode), note: NOTE[i.state] };
  });
  const blockers = parts.filter((p) => p.state !== 'installed' || p.mode !== 'enforce').map((p) => p.part);
  return { complete: blockers.length === 0, parts, blockers };
}

/** 導入承認の一覧（Task 10）。ソフト取得・適用・有料契約・外部送信・解除不能な保持を区別する。 */
export type ApprovalKind = 'acquire' | 'apply' | 'paid' | 'external' | 'irreversible';
export interface ApprovalItem { id: string; task: number; part: SecurityPart; title: string; kinds: ApprovalKind[] }
export const APPROVAL_LIST: readonly ApprovalItem[] = [
  { id: 'falco', task: 3, part: 'falco', title: 'Falco 本体・syscall ルール・Linux ドライバ・収集コンテナ（固定バージョン）と権限', kinds: ['acquire', 'apply'] },
  { id: 'resolver', task: 3, part: 'falco', title: '本番の共有リプレイストアと Docker / Kubernetes の識別リゾルバ、非公開 listener の接続', kinds: ['apply'] },
  { id: 'metrics', task: 4, part: 'metrics_proxy', title: 'metrics 収集器と必須の外向きプロキシ（固定イメージ・権限・Kubernetes metrics）', kinds: ['acquire', 'apply'] },
  { id: 'egress-policy', task: 4, part: 'metrics_proxy', title: '外向き NetworkPolicy の適用（TCP/UDP/IPv6 迂回拒否を実機で確認してから enforce）', kinds: ['apply'] },
  { id: 'ip-data', task: 6, part: 'network_data', title: 'IP 匿名化データの契約（MaxMind / IPinfo）、Tor 出口一覧、学校・iCloud Private Relay・Cloudflare bot の一覧', kinds: ['paid', 'external', 'acquire'] },
  { id: 'mmdb', task: 6, part: 'network_data', title: '（任意）MMDB 読み取り npm パッケージ。固定バージョンと lockfile 差分を先に提示', kinds: ['acquire'] },
  { id: 'db-audit', task: 7, part: 'db_audit', title: 'PostgreSQL 監査拡張（pgAudit など）とログ収集器、罠テーブルの migration', kinds: ['acquire', 'apply'] },
  { id: 'honeytoken-deploy', task: 7, part: 'honeytokens', title: '罠の値の生成・登録・配置（デプロイ時に実施）', kinds: ['apply'] },
  { id: 'safe-browsing', task: 5, part: 'safe_browsing', title: '外部 URL 検査サービス（Safe Browsing）の利用規約・認証情報・公開 URL の送信', kinds: ['external'] },
  { id: 'worm', task: 8, part: 'audit_worm', title: 'Object Lock 対応ストレージ（リージョン・保持期間・費用）と書き込み専用／読み取り専用の認証情報', kinds: ['paid', 'external', 'irreversible'] },
  { id: 'migrations', task: 8, part: 'audit_worm', title: '本番 DB への migration 0030〜0033 の適用', kinds: ['apply'] },
];
