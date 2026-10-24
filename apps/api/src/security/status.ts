import { assessProductionDefense, type PartInput, type SecurityPart } from 'shared';

/** 実測の入力。どれも注入式で、渡さなければ「確認できない」扱い。外部へは何も問い合わせない。 */
export interface StatusProbes {
  installed?: Partial<Record<SecurityPart, boolean>>;
  /** IP データの取得時刻と更新期限（ミリ秒）。超えていれば expired */
  networkData?: { fetchedAt: Date; maxAgeMs: number };
  /** 未配送の監査バッチ数（0 より大きければ undelivered） */
  auditUndelivered?: number;
  now?: Date;
}

const MODE_ENV: Record<SecurityPart, string | null> = {
  audit_worm: null, edge_gate: null, recovery: null,
  falco: 'SECURITY_FALCO_MODE', metrics_proxy: 'SECURITY_METRICS_MODE', network_data: 'SECURITY_NETWORK_MODE',
  honeytokens: 'SECURITY_HONEYTOKEN_MODE', db_audit: 'SECURITY_DB_AUDIT_MODE', safe_browsing: 'SECURITY_BROWSING_MODE',
};

/** 部品ごとの導入状態とモードを環境変数と注入された実測から組み立てる。何も導入していなければ全部 not_installed。 */
export function securityStatus(env: NodeJS.ProcessEnv, probes: StatusProbes = {}) {
  const now = probes.now ?? new Date();
  const input: Partial<Record<SecurityPart, PartInput>> = {};
  for (const part of ['audit_worm', 'edge_gate', 'recovery', 'falco', 'metrics_proxy', 'network_data', 'honeytokens', 'db_audit', 'safe_browsing'] as SecurityPart[]) {
    const known = probes.installed?.[part];
    let state: PartInput['state'] = known === undefined ? 'not_installed' : known ? 'installed' : 'not_installed';
    if (part === 'network_data' && state === 'installed' && probes.networkData && now.getTime() - probes.networkData.fetchedAt.getTime() > probes.networkData.maxAgeMs) state = 'expired';
    if (part === 'audit_worm' && state === 'installed' && (probes.auditUndelivered ?? 0) > 0) state = 'undelivered';
    const envName = MODE_ENV[part];
    // ゲート・復旧口・監査はモードを持たない常時有効の基盤。導入されていれば enforce 扱い。
    input[part] = { state, mode: envName ? env[envName] : state === 'installed' ? 'enforce' : undefined };
  }
  return assessProductionDefense(input);
}

export function formatStatus(s: ReturnType<typeof securityStatus>): string[] {
  const lines = s.parts.map((p) => `[${p.state === 'installed' ? 'OK' : p.state === 'not_installed' ? 'NOT INSTALLED' : p.state.toUpperCase()}] ${p.part} mode=${p.mode}: ${p.note}`);
  lines.push(s.complete ? 'Phase 6 production defense: COMPLETE' : `Phase 6 production defense: INCOMPLETE (${s.blockers.join(', ')})`);
  return lines;
}
