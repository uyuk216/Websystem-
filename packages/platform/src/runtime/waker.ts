import type { AppRunSpec, RuntimeDriver } from './driver.js';
import { waitHealthy, type HealthOptions } from './rollout.js';

export const WAKE_TIMEOUT_MS = 30_000;

export type WakeResult =
  | { ok: true; host: string; port: number }
  | { ok: false; reason: 'timeout' | 'failed' | 'missing' };

export interface WakerOptions {
  driver: RuntimeDriver;
  /** The run spec of the deployment (same one the rollout uses); null if it cannot be run. */
  buildSpec(appId: string, deploymentId: string): Promise<AppRunSpec | null>;
  /** Cross-process mutual exclusion per app (e.g. a Postgres advisory lock). Defaults to none (single process). */
  withLock?<T>(appId: string, fn: () => Promise<T>): Promise<T>;
  health?: HealthOptions;
  timeoutMs?: number;
  /** How long a known-good endpoint is reused without asking the driver (default 5s). */
  endpointTtlMs?: number;
  /** How long a failed wake is remembered, so a crash-looping app is not restarted by every request (default 5s). */
  failureTtlMs?: number;
}

/**
 * Makes sure an app's container is running and healthy. Concurrent callers for the same app share one wake
 * (in-process map) and processes are serialised with `withLock`, so `driver.start` runs once however many
 * requests arrive for a sleeping app. A caller waits at most `timeoutMs`; the wake itself keeps going.
 */
export class Waker {
  private readonly inflight = new Map<string, Promise<WakeResult>>();
  private readonly good = new Map<string, { at: number; host: string; port: number }>();
  private readonly bad = new Map<string, { at: number; reason: 'failed' | 'missing' }>();
  private readonly timeoutMs: number;
  private readonly endpointTtlMs: number;
  private readonly failureTtlMs: number;

  constructor(private readonly opts: WakerOptions) {
    this.timeoutMs = opts.timeoutMs ?? WAKE_TIMEOUT_MS;
    this.endpointTtlMs = opts.endpointTtlMs ?? 5_000;
    this.failureTtlMs = opts.failureTtlMs ?? 5_000;
  }

  /** Forget the cached endpoint (e.g. after a connection error: the app was stopped meanwhile). */
  invalidate(appId: string): void {
    for (const k of [...this.good.keys()]) if (k.startsWith(`${appId}:`)) this.good.delete(k);
  }

  async ensure(appId: string, deploymentId: string): Promise<WakeResult> {
    const key = `${appId}:${deploymentId}`;
    const hit = this.good.get(key);
    if (hit && Date.now() - hit.at < this.endpointTtlMs) return { ok: true, host: hit.host, port: hit.port };
    const miss = this.bad.get(key);
    if (miss && Date.now() - miss.at < this.failureTtlMs) return { ok: false, reason: miss.reason };

    let p = this.inflight.get(key);
    if (!p) {
      p = this.wake(appId, deploymentId).then((r) => {
        if (r.ok) this.good.set(key, { at: Date.now(), host: r.host, port: r.port });
        else if (r.reason !== 'timeout') this.bad.set(key, { at: Date.now(), reason: r.reason });
        if (this.good.size > 5000) this.good.clear();
        if (this.bad.size > 5000) this.bad.clear();
        return r;
      }, (e: unknown) => {
        console.error('wake failed', appId, e);
        const r = { ok: false, reason: 'failed' } as const;
        this.bad.set(key, { at: Date.now(), reason: 'failed' });
        return r;
      }).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<WakeResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), this.timeoutMs);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async wake(appId: string, deploymentId: string): Promise<WakeResult> {
    const { driver } = this.opts;
    const run = async (): Promise<WakeResult> => {
      // Another process may have woken the app while we waited for the lock.
      if ((await driver.status(appId, deploymentId)) === 'running') {
        const ep = await driver.endpoint(appId, deploymentId);
        if (ep) return { ok: true, ...ep };
      }
      const spec = await this.opts.buildSpec(appId, deploymentId);
      if (!spec) return { ok: false, reason: 'missing' };
      await driver.start(spec);
      const health = await waitHealthy(driver, appId, deploymentId, { ...this.opts.health, timeoutMs: this.opts.health?.timeoutMs ?? this.timeoutMs });
      if (!health.ok) {
        await driver.stopDeployment(appId, deploymentId).catch(() => undefined);
        return { ok: false, reason: health.reason === 'timeout' ? 'timeout' : 'failed' };
      }
      const ep = await driver.endpoint(appId, deploymentId);
      return ep ? { ok: true, ...ep } : { ok: false, reason: 'failed' };
    };
    return this.opts.withLock ? this.opts.withLock(appId, run) : run();
  }
}
