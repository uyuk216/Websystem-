import Docker from 'dockerode';
import { assertUuid } from './driver.js';
import type { AppRunSpec, RunHandle, RuntimeDriver, RuntimeStatus } from './driver.js';

export const APPS_NETWORK = 'ys-apps';
const NON_ROOT_USER = '65534:65534';

export interface DockerDriverOptions {
  docker?: Docker;
  /** OCI runtime, e.g. "runsc" (gVisor). Defaults to process.env.RUNTIME. */
  runtime?: string;
  warn?: (message: string) => void;
}

export const containerName = (appId: string, deploymentId: string): string => {
  assertUuid(appId, 'appId');
  assertUuid(deploymentId, 'deploymentId');
  return `ys-app-${appId}-${deploymentId.slice(0, 8)}`;
};
const ICC_OPTION = 'com.docker.network.bridge.enable_icc';

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
      const existing = (await this.docker.listNetworks({ filters: { name: [APPS_NETWORK] } })).find(
        (n) => n.Name === APPS_NETWORK,
      );
      if (existing) {
        const info = await this.docker.getNetwork(existing.Id).inspect();
        if (info.Options?.[ICC_OPTION] === 'false') return;
        // Created without ICC isolation: recreate (fails if containers are still attached).
        await this.docker.getNetwork(existing.Id).remove();
      }
      try {
        await this.docker.createNetwork({
          Name: APPS_NETWORK,
          Driver: 'bridge',
          CheckDuplicate: true,
          Options: { [ICC_OPTION]: 'false' },
        });
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
    assertUuid(spec.ownerId, 'ownerId');
    const name = containerName(spec.appId, spec.deploymentId);
    await this.docker.getImage(spec.image).inspect();
    const port = `${spec.port}/tcp`;
    const env = { ...spec.env, PORT: String(spec.port) };
    const container = await this.docker.createContainer({
      name,
      Image: spec.image,
      User: NON_ROOT_USER,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: { 'ys.app': spec.appId, 'ys.deployment': spec.deploymentId, 'ys.owner': spec.ownerId },
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
    try {
      await container.start();
    } catch (err) {
      await container.remove({ force: true }).catch(() => {});
      throw err;
    }
    return { appId: spec.appId, deploymentId: spec.deploymentId, containerId: container.id };
  }

  private async find(appId: string, deploymentId?: string): Promise<Docker.ContainerInfo[]> {
    assertUuid(appId, 'appId');
    const label = [`ys.app=${appId}`];
    if (deploymentId) {
      assertUuid(deploymentId, 'deploymentId');
      label.push(`ys.deployment=${deploymentId}`);
    }
    const list = await this.docker.listContainers({ all: true, filters: { label } });
    return list.sort((x, y) => y.Created - x.Created);
  }

  private async remove(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
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

  async stop(appId: string): Promise<void> {
    await Promise.all((await this.find(appId)).map((c) => this.remove(c.Id)));
  }

  async stopDeployment(appId: string, deploymentId: string): Promise<void> {
    await Promise.all((await this.find(appId, deploymentId)).map((c) => this.remove(c.Id)));
  }

  /** Prefers a running container, otherwise the newest. */
  private async pick(appId: string, deploymentId?: string): Promise<Docker.ContainerInfo | undefined> {
    const list = await this.find(appId, deploymentId);
    return list.find((c) => c.State === 'running') ?? list[0];
  }

  async status(appId: string, deploymentId?: string): Promise<RuntimeStatus> {
    const c = await this.pick(appId, deploymentId);
    if (!c) return 'stopped';
    try {
      const s = (await this.docker.getContainer(c.Id).inspect()).State;
      if (s.Running && !s.Restarting) return 'running';
      if (s.Restarting || s.Status === 'created') return 'starting';
      if (s.Status === 'exited' || s.Status === 'dead') return s.ExitCode === 0 ? 'stopped' : 'crashed';
      return 'stopped';
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return 'stopped';
      throw err;
    }
  }

  async endpoint(appId: string, deploymentId?: string): Promise<{ host: string; port: number } | null> {
    const c = await this.pick(appId, deploymentId);
    if (!c) return null;
    try {
      const info = await this.docker.getContainer(c.Id).inspect();
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

  async logs(appId: string, tail: number, deploymentId?: string): Promise<string[]> {
    const c = await this.pick(appId, deploymentId);
    if (!c) return [];
    try {
      const buf = (await this.docker
        .getContainer(c.Id)
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
