import { spawn } from 'node:child_process';

export interface BuildOptions {
  tag: string;
  timeoutMs?: number;
  maxImageBytes?: number;
  maxLogBytes?: number;
  /** Dockerfile name inside the context (default "Dockerfile"). */
  dockerfile?: string;
  docker?: string;
}
export type BuildResult =
  | { ok: true; imageRef: string; sizeBytes: number; log: string }
  | { ok: false; reason: 'timeout' | 'too_large' | 'build_failed'; log: string };

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

/**
 * Builds contextDir with `docker build` (network allowed, plain progress log). The build is killed when it
 * exceeds the time or log limit; an image over maxImageBytes is removed. The returned log never exceeds maxLogBytes.
 */
export async function buildImage(contextDir: string, opts: BuildOptions): Promise<BuildResult> {
  const timeoutMs = opts.timeoutMs ?? BUILD_DEFAULTS.timeoutMs;
  const maxImageBytes = opts.maxImageBytes ?? BUILD_DEFAULTS.maxImageBytes;
  const maxLogBytes = opts.maxLogBytes ?? BUILD_DEFAULTS.maxLogBytes;
  const bin = opts.docker ?? 'docker';
  const args = ['build', '--progress=plain', '--pull=false', '--rm', '--force-rm', '-t', opts.tag];
  if (opts.dockerfile) args.push('-f', opts.dockerfile);
  args.push(contextDir);

  const chunks: Buffer[] = [];
  let logBytes = 0;
  let overLog = false;
  let timedOut = false;
  const result = await new Promise<{ code: number | null }>((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    const kill = () => { try { process.kill(-p.pid!, 'SIGKILL'); } catch { p.kill('SIGKILL'); } };
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
    p.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  let log = Buffer.concat(chunks).toString('utf8');
  const note = (m: string) => { log += `\n[${m}]\n`; };
  const cleanup = () => run(bin, ['image', 'rm', '-f', opts.tag]);

  if (timedOut) { note(`build stopped: exceeded ${Math.round(timeoutMs / 1000)}s`); await cleanup(); return { ok: false, reason: 'timeout', log }; }
  if (overLog) { note(`build stopped: log exceeded ${maxLogBytes} bytes`); await cleanup(); return { ok: false, reason: 'build_failed', log }; }
  if (result.code !== 0) return { ok: false, reason: 'build_failed', log };

  const insp = await run(bin, ['image', 'inspect', '--format', '{{.Size}}', opts.tag]);
  const sizeBytes = Number.parseInt(insp.out.trim(), 10);
  if (insp.code !== 0 || !Number.isFinite(sizeBytes)) return { ok: false, reason: 'build_failed', log: `${log}\n[image inspect failed]\n` };
  if (sizeBytes > maxImageBytes) {
    note(`image is ${sizeBytes} bytes, over the ${maxImageBytes} byte limit`);
    await cleanup();
    return { ok: false, reason: 'too_large', log };
  }
  return { ok: true, imageRef: opts.tag, sizeBytes, log };
}
