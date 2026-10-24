/** No provider is constructed implicitly. Status never equates fixtures with installed sensors. */
export type DetectorMode = 'disabled' | 'observe' | 'enforce';
export interface SensorStatus { installed: boolean; mode: DetectorMode; lastSeen: number | null; dropped: number; unknownRules: number }
export interface MetricSample { appId: string; at: number; cpu: number; egressBytes: number; connections: number; servedBytes: number }
export interface TelemetryProvider { status(): SensorStatus; samples(): Promise<MetricSample[]> }
export const disabledTelemetry: TelemetryProvider = {
  status: () => ({ installed: false, mode: 'disabled', lastSeen: null, dropped: 0, unknownRules: 0 }), samples: async () => [],
};
export interface WorkloadIdentity { containerId: string; podUid: string; namespace: string; deployment: string }
export interface WorkloadResolver { resolve(identity: WorkloadIdentity): Promise<{ appId: string } | null> }
export function sensorProblems(status: SensorStatus, now: number, maxAgeMs = 60000): string[] {
  return [!status.installed ? 'not_installed' : null, status.lastSeen === null || now - status.lastSeen > maxAgeMs ? 'heartbeat_missing' : null,
    status.dropped > 0 ? 'events_dropped' : null, status.unknownRules > 0 ? 'unknown_rules' : null].filter((v): v is string => v !== null);
}
/** Implementations read runtime control-plane records, never tenant labels alone. */
export interface WorkloadInventory { current(): Promise<Array<WorkloadIdentity & { appId: string }>> }
export class InventoryWorkloadResolver implements WorkloadResolver {
  constructor(private inventory: WorkloadInventory) {}
  async resolve(identity: WorkloadIdentity): Promise<{ appId: string } | null> {
    const matches = (await this.inventory.current()).filter(w => w.containerId === identity.containerId && w.podUid === identity.podUid && w.namespace === identity.namespace && w.deployment === identity.deployment);
    return matches.length === 1 ? { appId: matches[0]!.appId } : null;
  }
}
export interface SensorAlertAdapter { notify(codes: string[]): Promise<void> }
export async function monitorSensor(provider: Pick<TelemetryProvider, 'status'>, alerts: SensorAlertAdapter, now: number): Promise<void> {
  const problems = sensorProblems(provider.status(), now);
  if (problems.length) await alerts.notify(problems);
}
