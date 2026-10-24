/** Explicit proxy adapter. Only categories/counters cross this boundary, never URLs/TLS bodies. */
export interface EgressRecord { appId: string; at: number; category: 'public_web' | 'database' | 'denied'; bytes: number; connections: number }
export interface EgressAdapter { installed: boolean; records(): Promise<EgressRecord[]> }
export const disabledEgress: EgressAdapter = { installed: false, records: async () => [] };
export interface EgressProxy { namespace: string; podLabel: string; port: number }
export function proxyEgressRules(proxy: EgressProxy): object[] {
  if (!/^[a-z0-9-]+$/.test(proxy.namespace) || !/^[a-z0-9-]+$/.test(proxy.podLabel) || !Number.isInteger(proxy.port) || proxy.port < 1024 || proxy.port > 65535) throw new Error('invalid_proxy');
  return [
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }], ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
    { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': proxy.namespace } }, podSelector: { matchLabels: { app: proxy.podLabel } } }], ports: [{ protocol: 'TCP', port: proxy.port }] },
  ];
}
/** Proxy authorization contract: no arbitrary TCP, UDP, IPv6 tunnel, private/metadata or SMTP destinations. */
export function authorizeEgress(request: { category: string; protocol: string; port: number; publicDestination: boolean }): boolean {
  return request.category === 'public_web' && request.protocol === 'TCP' && [80, 443].includes(request.port) && request.publicDestination;
}
