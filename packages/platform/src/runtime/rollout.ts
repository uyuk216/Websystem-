import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertUuid } from './driver.js';
import type { RuntimeDriver } from './driver.js';

const execFileP = promisify(execFile);

export const HEALTH_TIMEOUT_MS = 30_000;
export const HEALTH_INTERVAL_MS = 500;
export const LOG_TAIL_LINES = 50;

export interface HealthOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requestTimeoutMs?: number;
}

export type HealthResult = { ok: true } | { ok: false; reason: 'exited' | 'timeout' };

/**
 * Polls GET / on the deployment's container until it answers with a 2xx-4xx status (a 404 still proves the
 * server is up) or the deadline passes. A container that exited (crashed, or ignored PORT and stopped) fails
 * immediately; a 5xx or a refused connection is retried until the deadline.
 */
export async function waitHealthy(driver: RuntimeDriver, appId: string, deploymentId: string, opts: HealthOptions = {}): Promise<HealthResult> {
  const deadline = Date.now() + (opts.timeoutMs ?? HEALTH_TIMEOUT_MS);
  const interval = opts.intervalMs ?? HEALTH_INTERVAL_MS;
  for (;;) {
    const status = await driver.status(appId, deploymentId);
    if (status === 'crashed' || status === 'stopped') return { ok: false, reason: 'exited' };
    const ep = status === 'running' ? await driver.endpoint(appId, deploymentId) : null;
    if (ep) {
      try {
        const res = await fetch(`http://${ep.host}:${ep.port}/`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(Math.min(opts.requestTimeoutMs ?? 3000, Math.max(1, deadline - Date.now()))),
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 200 && res.status < 500) return { ok: true };
      } catch { /* not accepting connections yet */ }
    }
    if (Date.now() + interval >= deadline) return { ok: false, reason: 'timeout' };
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Last `tail` log lines of a deployment's container with every given secret value replaced. */
export async function collectLogs(driver: RuntimeDriver, appId: string, deploymentId: string, secrets: string[], tail = LOG_TAIL_LINES): Promise<string[]> {
  let lines: string[];
  try { lines = await driver.logs(appId, tail, deploymentId); } catch { return []; }
  const hide = secrets.filter((s) => s.length >= 4);
  return lines.slice(-tail).map((l) => hide.reduce((acc, s) => acc.split(s).join('***'), l.slice(0, 2000)));
}

/** Removes every image built for an app (`ys/<appId>:*`). */
export async function removeAppImages(appId: string, docker = 'docker'): Promise<void> {
  assertUuid(appId, 'appId');
  const { stdout } = await execFileP(docker, ['image', 'ls', '--filter', `reference=ys/${appId}`, '--format', '{{.Repository}}:{{.Tag}}']);
  const refs = stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`ys/${appId}:`));
  if (refs.length) await execFileP(docker, ['image', 'rm', '-f', ...refs]).catch(() => undefined);
}
