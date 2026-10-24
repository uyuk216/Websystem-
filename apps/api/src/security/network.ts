import { createNetworkReputation, NetworkDataStore } from 'platform';
import { parseNetworkMode, withNetworkMode, type NetworkMode, type NetworkReputation, type NetworkStatus } from 'shared';

/**
 * 入口（登録・提出開始）で使う判定器。データ取得元は未承認のため注入しない限り未導入で、モード既定は observe（通す）。
 * enforce でも未導入の間は unknown＝保護対象のみ 503。status() は doctor / 運営状態が「not installed」を報告するために使う。
 */
export function createNetworkGuard(env: NodeJS.ProcessEnv, store = new NetworkDataStore()): { reputation: NetworkReputation; mode: NetworkMode; store: NetworkDataStore; status(): NetworkStatus } {
  const mode = parseNetworkMode(env.SECURITY_NETWORK_MODE);
  const reputation = withNetworkMode(createNetworkReputation(store), mode);
  return { reputation, mode, store, status: () => store.status(mode) };
}
