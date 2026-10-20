/**
 * VPN / プロキシ / Tor の検知の差し替え口（スペック 9.8）。IP データベースはフェーズ 6。
 * 新規登録と学生証の提出で一律ブロックする。学校のネットワークと iCloud プライベートリレーは常に許可（例外リスト側の責務）。
 */
export type NetworkVerdict = { blocked: false } | { blocked: true; reason: 'vpn' | 'proxy' | 'tor' };

export interface NetworkReputation {
  check(ip: string): Promise<NetworkVerdict>;
}

/** 検知を行わない実装（IP データベース導入前の既定）。 */
export const allowAllNetworks: NetworkReputation = { check: async () => ({ blocked: false }) };

/** テスト用の固定実装：IP ごとに結果を決める。 */
export function staticNetworkReputation(blocked: Record<string, 'vpn' | 'proxy' | 'tor'>): NetworkReputation {
  return { check: async (ip) => (blocked[ip] ? { blocked: true, reason: blocked[ip] } : { blocked: false }) };
}
