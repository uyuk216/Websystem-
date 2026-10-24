import { NETWORK_EXCEPTIONS, normalizeNetworkIp, type NetworkDataStore } from './network-data.js';

/**
 * 判定順：壊れた IP / データなし・期限切れ → unknown、学校・Private Relay・信頼済みボットの例外 → 許可、Tor → VPN → proxy。
 * 例外はこの VPN 判定にだけ効く。罠・攻撃・アプリ遮断は `securityGate`（別経路）が見るので免除にはならない。
 * 一般の GeoIP だけでは VPN と見なさない（匿名化判定を提供する製品のデータだけを ranges に入れる）。
 */
export type NetworkCheck = { blocked: false } | { blocked: true; reason: 'vpn' | 'proxy' | 'tor' | 'unknown' };
export function createNetworkReputation(store: NetworkDataStore): { readonly installed: boolean; check(ip: string): Promise<NetworkCheck> } {
  return {
    get installed() { return store.current() !== null; },
    async check(raw: string): Promise<NetworkCheck> {
      const addr = normalizeNetworkIp(raw);
      const data = store.current();
      if (!addr || !data) return { blocked: true, reason: 'unknown' };
      for (const k of NETWORK_EXCEPTIONS) if (data.exceptions[k].check(addr.ip, addr.family)) return { blocked: false };
      for (const k of ['tor', 'vpn', 'proxy'] as const) if (data.ranges[k].check(addr.ip, addr.family)) return { blocked: true, reason: k };
      return { blocked: false };
    },
  };
}
