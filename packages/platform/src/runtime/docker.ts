import Docker from 'dockerode';
import type { AppRunSpec, RunHandle, RuntimeDriver, RuntimeStatus } from './driver.js';

export const APPS_NETWORK = 'ys-apps';
const NON_ROOT_USER = '65534:65534';

export interface DockerDriverOptions {
  docker?: Docker;
  /** OCI runtime, e.g. "runsc" (gVisor). Defaults to process.env.RUNTIME. */
  runtime?: string;
  warn?: (message: string) => void;
}

export const containerName = (appId: string): string => `ys-app-${appId}`;

function isRoot(user: string | undefined): boolean {
  if (!user) return true;
  const name = user.split(':')[0] ?? '';
  return name === '' || name === '0' || name === 'root';
}

export class DockerDriver implements RuntimeDriver {
  private readonly docker: Docker;
  private readonly runtime: string | undefined;
  private readonly warn: (message: string) => void;
  private networkReady: Promise<void> | null = null;

  constructor(options: DockerDriverOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.runtime = options.runtime ?? (process.env.RUNTIME || undefined);
    this.warn = options.warn ?? ((m) => console.warn(m));
    if (!this.runtime) {
      this.warn('RUNTIME is not set: running app containers with runc (development only, no gVisor)');
    }
  }

  async ensureImage(image: string): Promise<void> {
    await this.docker.getImage(image).inspect();
  }

  private ensureNetwork(): Promise<void> {
    this.networkReady ??= (async () => {
      const existing = await this.docker.listNetworks({ filters: { name: [APPS_NETWORK] } });
      if (existing.some((n) => n.Name === APPS_NETWORK)) return;
      try {
        await this.docker.createNetwork({ Name: APPS_NETWORK, Driver: 'bridge', CheckDuplicate: true });
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 409) throw err;
      }
    })().catch((err) => {
      this.networkReady = null;
      throw err;
    });
    return this.networkReady;
  }

  async start(spec: AppRunSpec): Promise<RunHandle> {
    await this.ensureNetwork();
    const imageInfo = await this.docker.getImage(spec.image).inspect();
    const user = isRoot(imageInfo.Config?.User) ? NON_ROOT_USER : imageInfo.Config.User;
    await this.stop(spec.appId);
    const port = `${spec.port}/tcp`;
    const env = { ...spec.env, PORT: String(spec.port) };
    const container = await this.docker.createContainer({
      name: containerName(spec.appId),
      Image: spec.image,
      User: user,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'ys.app': spec.appId, 'ys.owner': spec.ownerId },
      ExposedPorts: { [port]: {} },
      HostConfig: {
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        Memory: spec.limits.memoryMb * 1024 * 1024,
        MemorySwap: spec.limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.round(spec.limits.cpu * 1e9),
        PidsLimit: spec.limits.pids,
        NetworkMode: APPS_NETWORK,
        PortBindings: { [port]: [{ HostIp: '127.0.0.1', HostPort: '' }] },
        RestartPolicy: { Name: 'no' },
        ...(this.runtime ? { Runtime: this.runtime } : {}),
      },
    });
    await container.start();
    return { appId: spec.appId, containerId: container.id };
  }

  async stop(appId: string): Promise<void> {
    const container = this.docker.getContainer(containerName(appId));
    try {
      await container.stop({ t: 2 });
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404) return;
      if (code !== 304) throw err;
    }
    try {
      await container.remove({ force: true });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
  }

  async status(appId: string): Promise<RuntimeStatus> {
    try {
      const info = await this.docker.getContainer(containerName(appId)).inspect();
      const s = info.State;
      if (s.Running && !s.Restarting) return 'running';
      if (s.Restarting || s.Status === 'created') return 'starting';
      if (s.Status === 'exited' || s.Status === 'dead') return s.ExitCode === 0 ? 'stopped' : 'crashed';
      return 'stopped';
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return 'stopped';
      throw err;
    }
  }

  async endpoint(appId: string): Promise<{ host: string; port: number } | null> {
    try {
      const info = await this.docker.getContainer(containerName(appId)).inspect();
      if (!info.State.Running) return null;
      for (const bindings of Object.values(info.NetworkSettings.Ports ?? {})) {
        const b = bindings?.find((x) => x.HostIp === '127.0.0.1');
        if (b) return { host: '127.0.0.1', port: Number(b.HostPort) };
      }
      return null;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async logs(appId: string, tail: number): Promise<string[]> {
    try {
      const buf = (await this.docker
        .getContainer(containerName(appId))
        .logs({ stdout: true, stderr: true, tail, follow: false })) as unknown as Buffer;
      const lines = demux(buf).split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return [];
      throw err;
    }
  }

  async runningCount(): Promise<Array<{ appId: string; containers: number }>> {
    const list = await this.docker.listContainers({ filters: { label: ['ys.app'], status: ['running'] } });
    const counts = new Map<string, number>();
    for (const c of list) {
      const id = c.Labels['ys.app'];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].map(([appId, containers]) => ({ appId, containers }));
  }
}

/** Strip Docker's 8-byte multiplexed stream frame headers (non-TTY containers). */
function demux(buf: Buffer): string {
  let out = '';
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, i + 8 + size).toString('utf8');
    i += 8 + size;
  }
  return out;
}
