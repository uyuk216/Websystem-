export interface AppRunSpec {
  appId: string;
  ownerId: string;
  image: string;
  env: Record<string, string>;
  limits: { memoryMb: number; cpu: number; pids: number };
  port: number;
}

export interface RunHandle {
  appId: string;
  containerId: string;
}

export type RuntimeStatus = 'running' | 'stopped' | 'starting' | 'crashed';

export interface RuntimeDriver {
  ensureImage?(image: string): Promise<void>;
  start(spec: AppRunSpec): Promise<RunHandle>;
  stop(appId: string): Promise<void>;
  status(appId: string): Promise<RuntimeStatus>;
  endpoint(appId: string): Promise<{ host: string; port: number } | null>;
  logs(appId: string, tail: number): Promise<string[]>;
  runningCount(): Promise<Array<{ appId: string; containers: number }>>;
}
