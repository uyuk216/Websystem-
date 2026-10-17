import { spawn } from 'node:child_process';

export interface BuildOptions {
  tag: string;
  timeoutMs?: number;
  maxImageBytes?: number;
  maxLogBytes?: number;
  /** Dockerfile name inside the context (default "Dockerfile"). */
  dockerfile?: string;
  docker?: string;
  /** Identifies this build (deployment id). Containers/images it creates are tracked and cleaned up by it. */
  buildId?: string;
  memoryBytes?: number;
}
export type BuildResult =
  | { ok: true; imageRef: string; sizeBytes: number; log: string }
  | { ok: false; reason: 'timeout' | 'too_large' | 'build_failed'; log: string };

export const BUILD_NETWORK = 'ys-build';
const KILL_GRACE_MS = 10_000;

export const BUILD_DEFAULTS = { timeoutMs: 15 * 60_000, maxImageBytes: 1024 ** 3, maxLogBytes: 5 * 1024 ** 2 } as const;

function run(bin: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('error', (e) => resolve({ code: -1, out: String(e) }));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function ensureBuildNetwork(bin: string): Promise<void> {
  if ((await run(bin, ['network', 'inspect', BUILD_NETWORK])).code === 0) return;
  // enable_icc=false: build steps cannot reach each other's containers. A concurrent create losing the race is fine.
  await run(bin, ['network', 'create', '--driver', 'bridge', '-o', 'com.docker.network.bridge.enable_icc=false', BUILD_NETWORK]);
}

const cgroupOf = (buildId: string): string => `ys-build-${buildId}`;

/** Removes containers (and dangling layers) left behind by one build. Only touches things tagged with this buildId. */
export async function cleanupBuild(buildId: string, docker = 'docker'): Promise<void> {
  const ids = (await run(docker, ['ps', '-aq'])).out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const id of ids) {
    const r = await run(docker, ['inspect', '--format', '{{.HostConfig.CgroupParent}}', id]);
    if (r.code === 0 && r.out.trim() === cgroupOf(buildId)) await run(docker, ['rm', '-f', '-v', id]);
  }
  await run(docker, ['image', 'prune', '-f', '--filter', `label=ys.build=${buildId}`]);
}

/**
 * Builds contextDir with the classic builder (DOCKER_BUILDKIT=0) so memory/CPU limits apply to build steps;
 * production builds run in an isolated rootless BuildKit (Phase 8). Network access is allowed but only on the
 * dedicated ys-build network. The build is killed when it
 * exceeds the time or log limit; an image over maxImageBytes is removed. The returned log never exceeds maxLogBytes.
 */
export async function buildImage(contextDir: string, opts: BuildOptions): Promise<BuildResult> {
  const timeoutMs = opts.timeoutMs ?? BUILD_DEFAULTS.timeoutMs;
  const maxImageBytes = opts.maxImageBytes ?? BUILD_DEFAULTS.maxImageBytes;
  const maxLogBytes = opts.maxLogBytes ?? BUILD_DEFAULTS.maxLogBytes;
  const bin = opts.docker ?? 'docker';
  const buildId = opts.buildId ?? opts.tag.replace(/[^A-Za-z0-9_.-]/g, '-');
  const mem = String(opts.memoryBytes ?? 1024 ** 3);
  await ensureBuildNetwork(bin);
  const args = [
    'build', '--rm', '--force-rm', '--memory', mem, '--memory-swap', mem, '--cpu-quota', '100000', '--cpu-period', '100000',
    '--network', BUILD_NETWORK, '--cgroup-parent', cgroupOf(buildId), '--label', `ys.build=${buildId}`, '-t', opts.tag,
  ];
  if (opts.dockerfile) args.push('-f', opts.dockerfile);
  args.push(contextDir);

  const chunks: Buffer[] = [];
  let logBytes = 0;
  let overLog = false;
  let timedOut = false;
  const result = await new Promise<{ code: number | null }>((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, DOCKER_BUILDKIT: '0' } });
    let killer: NodeJS.Timeout | undefined;
    // SIGINT lets the CLI cancel the build on the daemon; SIGKILL follows after a grace period.
    const kill = () => {
      p.kill('SIGINT');
      killer = setTimeout(() => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } }, KILL_GRACE_MS);
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onData = (d: Buffer) => {
      if (overLog) return;
      const room = maxLogBytes - logBytes;
      if (d.length > room) {
        if (room > 0) chunks.push(d.subarray(0, room));
        logBytes = maxLogBytes;
        overLog = true;
        kill();
        return;
      }
      chunks.push(d);
      logBytes += d.length;
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => { chunks.push(Buffer.from(`${e}\n`)); });
    p.on('close', (code) => { clearTimeout(timer); clearTimeout(killer); resolve({ code }); });
  });

  let log = Buffer.concat(chunks).toString('utf8');
  const note = (m: string) => { log += `\n[${m}]\n`; };
  const cleanup = async () => { await cleanupBuild(buildId, bin); await run(bin, ['image', 'rm', '-f', opts.tag]); };

  if (timedOut) { note(`build stopped: exceeded ${Math.round(timeoutMs / 1000)}s`); await cleanup(); return { ok: false, reason: 'timeout', log }; }
  if (overLog) { note(`build stopped: log exceeded ${maxLogBytes} bytes`); await cleanup(); return { ok: false, reason: 'build_failed', log }; }
  if (result.code !== 0) { await cleanup(); return { ok: false, reason: 'build_failed', log }; }

  const insp = await run(bin, ['image', 'inspect', '--format', '{{.Size}}', opts.tag]);
  const sizeBytes = Number.parseInt(insp.out.trim(), 10);
  if (insp.code !== 0 || !Number.isFinite(sizeBytes)) { await cleanup(); return { ok: false, reason: 'build_failed', log: `${log}\n[image inspect failed]\n` }; }
  if (sizeBytes > maxImageBytes) {
    note(`image is ${sizeBytes} bytes, over the ${maxImageBytes} byte limit`);
    await cleanup();
    return { ok: false, reason: 'too_large', log };
  }
  return { ok: true, imageRef: opts.tag, sizeBytes, log };
}

/**
 * Pushes a built image to a registry the cluster pulls from (Kubernetes driver) and returns the remote ref.
 * The local tag is kept; removeImage(remote) removes the local copy of the remote tag only.
 */
export async function pushImage(tag: string, registry: string, docker = 'docker'): Promise<{ ok: true; imageRef: string } | { ok: false; log: string }> {
  // host[:port][/path], lower case; no "." / ".." path segments
  if (!/^[a-z0-9.-]+(:[0-9]+)?(\/(?!\.+(\/|$))[a-z0-9._-]+)*$/.test(registry)) return { ok: false, log: `invalid registry: ${registry}` };
  const remote = `${registry}/${tag}`;
  const t = await run(docker, ['image', 'tag', tag, remote]);
  if (t.code !== 0) return { ok: false, log: t.out };
  const p = await run(docker, ['image', 'push', remote]);
  if (p.code !== 0) {
    await run(docker, ['image', 'rm', '-f', remote]);
    return { ok: false, log: p.out };
  }
  return { ok: true, imageRef: remote };
}

/** Removes an image this module built (no error when it does not exist). */
export async function removeImage(tag: string, docker = 'docker'): Promise<void> {
  await run(docker, ['image', 'rm', '-f', tag]);
}
