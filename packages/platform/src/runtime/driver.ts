export interface AppRunSpec {
  appId: string;
  deploymentId: string;
  ownerId: string;
  image: string;
  env: Record<string, string>;
  limits: { memoryMb: number; cpu: number; pids: number };
  port: number;
}

export interface RunHandle {
  appId: string;
  deploymentId: string;
  containerId: string;
}

export type RuntimeStatus = 'running' | 'stopped' | 'starting' | 'crashed';

export interface RuntimeDriver {
  ensureImage?(image: string): Promise<void>;
  start(spec: AppRunSpec): Promise<RunHandle>;
  /** Stops every container of the app (all deployments). */
  stop(appId: string): Promise<void>;
  stopDeployment(appId: string, deploymentId: string): Promise<void>;
  status(appId: string, deploymentId?: string): Promise<RuntimeStatus>;
  endpoint(appId: string, deploymentId?: string): Promise<{ host: string; port: number } | null>;
  logs(appId: string, tail: number, deploymentId?: string): Promise<string[]>;
  runningCount(): Promise<Array<{ appId: string; containers: number }>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(value: string, what: string): void {
  if (!UUID.test(value)) throw new Error(`invalid ${what}: expected a UUID`);
}
