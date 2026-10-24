/**
 * VPN / プロキシ / Tor の検知の差し替え口（スペック 9.8）。IP データベースはフェーズ 6。
 * 新規登録と学生証の提出で一律ブロックする。学校のネットワークと iCloud プライベートリレーは常に許可（例外リスト側の責務）。
 */
export type NetworkVerdict = { blocked: false } | { blocked: true; reason: 'vpn' | 'proxy' | 'tor' | 'unknown' };

export interface NetworkReputation {
  /** false = データ未導入（doctor / status は「not installed」）。省略時は導入済み扱い。 */
  installed?: boolean;
  check(ip: string): Promise<NetworkVerdict>;
}

/** 検知を行わない実装（IP データベース導入前の既定）。 */
export const allowAllNetworks: NetworkReputation = { check: async () => ({ blocked: false }) };

/** テスト用の固定実装：IP ごとに結果を決める。 */
export function staticNetworkReputation(blocked: Record<string, 'vpn' | 'proxy' | 'tor'>): NetworkReputation {
  return { check: async (ip) => (blocked[ip] ? { blocked: true, reason: blocked[ip] } : { blocked: false }) };
}

// ---- Phase 6 Task 6: 操作ごとの判定表と運用モード ----

/** `unknown` はデータ未導入・期限切れ・壊れた IP のとき。既知の VPN 等（403）と区別し、保護対象の操作だけ 503 にする。 */
export type NetworkBlockReason = 'vpn' | 'proxy' | 'tor' | 'unknown';

export type NetworkAction =
  | 'signup' | 'verification_start' | 'id_upload' | 'pro_purchase' // VPN 等を拒否する保護対象
  | 'store_application' | 'login' | 'site_change' | 'view' | 'admin'; // VPN だけでは止めない

const PROTECTED_ACTIONS: ReadonlySet<NetworkAction> = new Set(['signup', 'verification_start', 'id_upload', 'pro_purchase']);
export const isProtectedNetworkAction = (a: NetworkAction): boolean => PROTECTED_ACTIONS.has(a);

export type NetworkDecision = { allow: true } | { allow: false; status: 403 | 503; reason: NetworkBlockReason };

/** 判定表：保護対象のみ、既知の VPN / proxy / Tor は 403、unknown は 503。その他の操作は常に許可。 */
export function decideNetworkAction(action: NetworkAction, verdict: NetworkVerdict): NetworkDecision {
  if (!verdict.blocked || !PROTECTED_ACTIONS.has(action)) return { allow: true };
  const reason = verdict.reason as NetworkBlockReason;
  return { allow: false, status: reason === 'unknown' ? 503 : 403, reason };
}

/** off=判定しない、observe=判定結果を観測へ渡すだけで通す（未設定の既定）、enforce=判定どおり拒否。 */
export type NetworkMode = 'off' | 'observe' | 'enforce';
export function parseNetworkMode(raw: string | undefined): NetworkMode {
  return raw === 'enforce' || raw === 'off' ? raw : 'observe';
}

/** 未導入の判定器。`installed:false` を doctor / status が「not installed」と報告する。enforce でも導入前は unknown（保護対象は 503）。 */
export const unconfiguredNetworks: NetworkReputation & { installed: false } = { installed: false, check: async () => ({ blocked: true, reason: 'unknown' }) };

export function withNetworkMode(rep: NetworkReputation, mode: NetworkMode, onObserve?: (ip: string, verdict: NetworkVerdict) => void): NetworkReputation {
  if (mode === 'enforce') return rep;
  return { get installed() { return rep.installed; }, async check(ip) {
    if (mode === 'observe') { try { onObserve?.(ip, await rep.check(ip)); } catch { /* observe only */ } }
    return { blocked: false };
  } };
}

export interface NetworkStatus { installed: boolean; mode: NetworkMode; dataVersion: string | null; fetchedAt: string | null; expiresAt: string | null; state: 'not_installed' | 'ok' | 'expired' }

/** X-Forwarded-For は信頼した proxy の段数ぶん右から数える。段数 0 なら接続元アドレスだけを使う。 */
export function forwardedClientIp(xff: string | undefined, socketAddr: string | undefined, hops: number): string | null {
  const strip = (s: string): string => s.trim().replace(/^::ffff:/i, '');
  if (hops <= 0 || !xff) return socketAddr ? strip(socketAddr) : null;
  const parts = xff.split(',').map((p) => p.trim()).filter(Boolean);
  const v = parts[parts.length - hops];
  return v ? strip(v) : null;
}
