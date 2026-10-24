import { BlockList, isIP } from 'node:net';
export interface NetworkDataStatus { installed: boolean; mode: 'off' | 'observe' | 'enforce'; dataVersion: string | null; fetchedAt: string | null; expiresAt: string | null; state: 'not_installed' | 'ok' | 'expired' }

/**
 * VPN / proxy / Tor 判定データの検証・保持（スペック 9.8）。実データの取得元（IP 情報製品・Tor 出口一覧・学校 CIDR・
 * iCloud Private Relay・Cloudflare の信頼済みボット）は未承認のため、ここは「検証済みの JSON を受け取る」境界だけ。
 * 更新は検証成功後に参照を差し替える（atomic swap）。失敗時は期限内の前版を使い続け、期限切れは unknown になる。
 */
export const NETWORK_LISTS = ['vpn', 'proxy', 'tor'] as const;
export const NETWORK_EXCEPTIONS = ['school', 'relay', 'bot'] as const;
export type NetworkList = (typeof NETWORK_LISTS)[number];
export type NetworkException = (typeof NETWORK_EXCEPTIONS)[number];

export interface NetworkDatasetJson {
  version: string; fetchedAt: string; maxAgeSeconds: number;
  ranges: Record<NetworkList, string[]>; exceptions: Record<NetworkException, string[]>;
}
export interface CompiledNetworkData {
  version: string; fetchedAt: number; expiresAt: number;
  ranges: Record<NetworkList, BlockList>; exceptions: Record<NetworkException, BlockList>;
}
export const MAX_NETWORK_AGE_SECONDS = 14 * 86400;
const MAX_ENTRIES = 1_000_000;

export function normalizeNetworkIp(raw: string): { ip: string; family: 'ipv4' | 'ipv6' } | null {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) s = mapped[1]!;
  const v = isIP(s);
  return v === 4 ? { ip: s, family: 'ipv4' } : v === 6 ? { ip: s, family: 'ipv6' } : null;
}

function compileList(entries: unknown): BlockList {
  if (!Array.isArray(entries)) throw new Error('invalid_ranges');
  const list = new BlockList();
  for (const e of entries) {
    if (typeof e !== 'string') throw new Error('invalid_cidr');
    const m = /^([^/]+)\/(\d{1,3})$/.exec(e);
    const addr = m ? normalizeNetworkIp(m[1]!) : normalizeNetworkIp(e);
    if (!addr) throw new Error('invalid_cidr');
    const prefix = m ? Number(m[2]) : addr.family === 'ipv4' ? 32 : 128;
    if (prefix > (addr.family === 'ipv4' ? 32 : 128)) throw new Error('invalid_cidr');
    list.addSubnet(addr.ip, prefix, addr.family);
  }
  return list;
}

/** 検証して compile する。壊れた CIDR・未来の取得時刻・期限切れ・過大な保持期間・巨大な一覧はすべて拒否。 */
export function compileNetworkDataset(raw: unknown, now: number): CompiledNetworkData {
  const d = raw as Partial<NetworkDatasetJson> | null;
  if (!d || typeof d !== 'object' || typeof d.version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(d.version)) throw new Error('invalid_version');
  const fetchedAt = typeof d.fetchedAt === 'string' ? Date.parse(d.fetchedAt) : NaN;
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 5 * 60_000) throw new Error('invalid_fetched_at');
  const age = d.maxAgeSeconds;
  if (!Number.isSafeInteger(age) || age! <= 0 || age! > MAX_NETWORK_AGE_SECONDS) throw new Error('invalid_max_age');
  const expiresAt = fetchedAt + age! * 1000;
  if (expiresAt <= now) throw new Error('expired');
  if (!d.ranges || !d.exceptions) throw new Error('invalid_ranges');
  const count = [...NETWORK_LISTS.map((k) => d.ranges![k]), ...NETWORK_EXCEPTIONS.map((k) => d.exceptions![k])].reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  if (count > MAX_ENTRIES) throw new Error('too_large');
  return {
    version: d.version, fetchedAt, expiresAt,
    ranges: Object.fromEntries(NETWORK_LISTS.map((k) => [k, compileList(d.ranges![k])])) as Record<NetworkList, BlockList>,
    exceptions: Object.fromEntries(NETWORK_EXCEPTIONS.map((k) => [k, compileList(d.exceptions![k])])) as Record<NetworkException, BlockList>,
  };
}

export class NetworkDataStore {
  private data: CompiledNetworkData | null = null;
  constructor(private now: () => number = Date.now) {}
  /** 期限内の版（なければ null＝unknown）。 */
  current(): CompiledNetworkData | null {
    return this.data && this.data.expiresAt > this.now() ? this.data : null;
  }
  update(raw: unknown): { ok: true; version: string } | { ok: false; error: string } {
    try {
      const next = compileNetworkDataset(raw, this.now());
      if (this.data && next.fetchedAt < this.data.fetchedAt) return { ok: false, error: 'stale_rollback' };
      this.data = next; // atomic swap
      return { ok: true, version: next.version };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'invalid' };
    }
  }
  status(mode: NetworkDataStatus['mode']): NetworkDataStatus {
    const d = this.data;
    if (!d) return { installed: false, mode, dataVersion: null, fetchedAt: null, expiresAt: null, state: 'not_installed' };
    return { installed: true, mode, dataVersion: d.version, fetchedAt: new Date(d.fetchedAt).toISOString(), expiresAt: new Date(d.expiresAt).toISOString(), state: d.expiresAt > this.now() ? 'ok' : 'expired' };
  }
}

/** 実データ取得の差し替え口。承認前は何も取得しない。 */
export interface NetworkDataSource { installed: boolean; fetch(signal: AbortSignal): Promise<unknown> }
export const disabledNetworkSource: NetworkDataSource = { installed: false, fetch: async () => { throw new Error('not_installed'); } };

export async function refreshNetworkData(store: NetworkDataStore, source: NetworkDataSource, timeoutMs = 10_000): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  if (!source.installed) return { ok: false, error: 'not_installed' };
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try { return store.update(await source.fetch(ac.signal)); }
  catch { return { ok: false, error: 'fetch_failed' }; } // 前版は期限まで使い続ける
  finally { clearTimeout(timer); }
}
