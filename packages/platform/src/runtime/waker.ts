import type { AppRunSpec, RuntimeDriver } from './driver.js';
import { waitHealthy, type HealthOptions } from './rollout.js';

export const WAKE_TIMEOUT_MS = 30_000;

export type WakeResult =
  | { ok: true; host: string; port: number }
  | { ok: false; reason: 'timeout' | 'failed' | 'missing' | 'blocked' };

export interface WakerOptions {
  driver: RuntimeDriver;
  /** The run spec of the deployment (same one the rollout uses); null if it cannot be run. */
  buildSpec(appId: string, deploymentId: string): Promise<AppRunSpec | null>;
  /**
   * Cross-process mutual exclusion per app (e.g. a Postgres advisory lock on a dedicated pool). Defaults to none
   * (single process). `fn` only talks to the driver: the run spec is built before the lock is taken.
   */
  withLock?<T>(appId: string, fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>;
  health?: HealthOptions;
  /**
   * Asked inside the wake lock, right before the container is started: false refuses the start (`blocked`).
   * Used for security blocks, so a wake cannot restart an app that was stopped for a security reason. Not cached.
   */
  allowStart?(appId: string): Promise<boolean>;
  timeoutMs?: number;
  /** How long a known-good endpoint is reused without asking the driver (default 5s). */
  endpointTtlMs?: number;
  /** How long a failed wake is remembered, so a crash-looping app is not restarted by every request (default 5s). */
  failureTtlMs?: number;
  /** Wakes running at the same time in this process (default 8); the rest wait in line within their time budget. */
  maxConcurrentWakes?: number;
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
  private readonly maxWakes: number;
  private activeWakes = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly opts: WakerOptions) {
    this.timeoutMs = opts.timeoutMs ?? WAKE_TIMEOUT_MS;
    this.endpointTtlMs = opts.endpointTtlMs ?? 5_000;
    this.failureTtlMs = opts.failureTtlMs ?? 5_000;
    this.maxWakes = opts.maxConcurrentWakes ?? 8;
  }

  /** Takes a wake slot, waiting in line until `deadline`; false when the deadline came first. */
  private async acquire(deadline: number): Promise<boolean> {
    if (this.activeWakes < this.maxWakes) {
      this.activeWakes++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => { clearTimeout(timer); resolve(true); }; // the slot is handed over, activeWakes unchanged
      const timer = setTimeout(() => {
        const i = this.queue.indexOf(grant);
        if (i !== -1) this.queue.splice(i, 1);
        resolve(false);
      }, Math.max(0, deadline - Date.now()));
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.activeWakes--;
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
      p = this.wake(appId, deploymentId, Date.now() + this.timeoutMs).then((r) => {
        if (r.ok) this.good.set(key, { at: Date.now(), host: r.host, port: r.port });
        else if (r.reason === 'failed' || r.reason === 'missing') this.bad.set(key, { at: Date.now(), reason: r.reason });
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

  private async wake(appId: string, deploymentId: string, deadline: number): Promise<WakeResult> {
    const { driver } = this.opts;
    const left = () => Math.max(0, deadline - Date.now());
    /** Everything that can wait (queue, spec, lock, start) is bounded by the wake deadline. */
    const within = async <T>(p: Promise<T>): Promise<T | typeof TIMED_OUT> => {
      let t: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([p, new Promise<typeof TIMED_OUT>((r) => { t = setTimeout(() => r(TIMED_OUT), left()); })]);
      } finally { clearTimeout(t); }
    };
    if (!(await this.acquire(deadline))) return { ok: false, reason: 'timeout' };
    try {
      const quick = await within((async (): Promise<WakeResult | null> => {
        if ((await driver.status(appId, deploymentId)) === 'running') {
          const ep = await driver.endpoint(appId, deploymentId);
          if (ep) return { ok: true, ...ep };
        }
        return null;
      })());
      if (quick === TIMED_OUT) return { ok: false, reason: 'timeout' };
      if (quick) return quick;
      // Built before the lock: nothing inside the lock needs a database connection.
      const spec = await within(this.opts.buildSpec(appId, deploymentId));
      if (spec === TIMED_OUT) return { ok: false, reason: 'timeout' };
      const run = async (): Promise<WakeResult> => {
        // Another process may have woken the app while we waited for the lock.
        if ((await driver.status(appId, deploymentId)) === 'running') {
          const ep = await driver.endpoint(appId, deploymentId);
          if (ep) return { ok: true, ...ep };
        }
        if (!spec) return { ok: false, reason: 'missing' };
        if (this.opts.allowStart) {
          const allowed = await within(this.opts.allowStart(appId));
          if (allowed === TIMED_OUT) return { ok: false, reason: 'timeout' };
          if (!allowed) return { ok: false, reason: 'blocked' };
        }
        if (left() <= 0) return { ok: false, reason: 'timeout' };
        const started = await within(driver.start(spec));
        if (started === TIMED_OUT) return { ok: false, reason: 'timeout' };
        const health = await waitHealthy(driver, appId, deploymentId, { ...this.opts.health, timeoutMs: Math.min(this.opts.health?.timeoutMs ?? left(), Math.max(1, left())) });
        if (!health.ok) {
          await driver.stopDeployment(appId, deploymentId).catch(() => undefined);
          return { ok: false, reason: health.reason === 'timeout' ? 'timeout' : 'failed' };
        }
        const ep = await driver.endpoint(appId, deploymentId);
        return ep ? { ok: true, ...ep } : { ok: false, reason: 'failed' };
      };
      try {
        return await (this.opts.withLock ? this.opts.withLock(appId, run, { timeoutMs: left() }) : run());
      } catch (e) {
        if ((e as Error).message === 'wake_lock_timeout') return { ok: false, reason: 'timeout' };
        throw e;
      }
    } finally {
      this.release();
    }
  }
}

const TIMED_OUT = Symbol('timed out');
