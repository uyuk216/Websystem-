import { execFileSync, spawnSync } from 'node:child_process';
import Docker from 'dockerode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { APPS_NETWORK, DockerDriver } from '../../src/runtime/docker.js';

const docker = new Docker();
let available = true;
try {
  await docker.ping();
} catch {
  available = false;
  console.warn('SKIP: Docker socket unavailable; docker driver tests are skipped (CI has Docker)');
}

const IMAGE = 'ys-test-httpd:1';
const DOCKERFILE = `FROM busybox
RUN mkdir /www && echo hello-from-app > /www/index.html
USER 1000:1000
CMD ["sh","-c","echo started-up; exec httpd -f -p $PORT -h /www"]
`;
const ROOT_IMAGE = 'ys-test-httpd-root:1';
const limits = { memoryMb: 128, cpu: 0.5, pids: 64 };
const ids = ['t1a', 't1b'];

describe.skipIf(!available)('DockerDriver', { timeout: 30_000 }, () => {
  const driver = new DockerDriver({ runtime: undefined, warn: () => {} });

  beforeAll(() => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-'], { input: DOCKERFILE });
    execFileSync('docker', ['build', '-q', '-t', ROOT_IMAGE, '-'], {
      input: DOCKERFILE.replace('USER 1000:1000\n', ''),
    });
  }, 120_000);

  afterEach(async () => {
    for (const id of ids) await driver.stop(id);
  });

  afterAll(() => {
    spawnSync('docker', ['rmi', '-f', IMAGE, ROOT_IMAGE]);
    spawnSync('docker', ['network', 'rm', APPS_NETWORK]);
  });

  const spec = (appId: string, image = IMAGE) => ({
    appId,
    ownerId: 'owner-1',
    image,
    env: { FOO: 'bar' },
    limits,
    port: 8080,
  });

  async function waitOk(url: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.text();
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('app did not respond');
  }

  it('starts an app, serves HTTP on 127.0.0.1, and reports logs/status/count', async () => {
    const handle = await driver.start(spec('t1a'));
    expect(handle.appId).toBe('t1a');
    const ep = await driver.endpoint('t1a');
    expect(ep?.host).toBe('127.0.0.1');
    expect(await waitOk(`http://127.0.0.1:${ep!.port}/`)).toContain('hello-from-app');
    expect(await driver.status('t1a')).toBe('running');
    expect(await driver.logs('t1a', 10)).toContain('started-up');
    expect(await driver.runningCount()).toContainEqual({ appId: 't1a', containers: 1 });
  });

  it('applies the isolation settings', async () => {
    await driver.start(spec('t1a'));
    const info = await docker.getContainer('ys-app-t1a').inspect();
    const hc = info.HostConfig;
    expect(info.Config.Labels['ys.app']).toBe('t1a');
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.SecurityOpt).toContain('no-new-privileges');
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Privileged).toBe(false);
    expect(hc.Memory).toBe(128 * 1024 * 1024);
    expect(hc.NanoCpus).toBe(5e8);
    expect(hc.PidsLimit).toBe(64);
    expect(hc.Tmpfs?.['/tmp']).toContain('size=64m');
    expect(hc.NetworkMode).not.toBe('host');
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([APPS_NETWORK]);
    expect(info.Config.User).toBe('1000:1000');
    for (const b of Object.values((hc.PortBindings ?? {}) as Record<string, Array<{ HostIp: string }>>)) {
      expect(b.every((x) => x.HostIp === '127.0.0.1')).toBe(true);
    }
    expect(info.Config.Env).toContain('PORT=8080');
  });

  it('forces a non-root user when the image defaults to root', async () => {
    await driver.start(spec('t1b', ROOT_IMAGE));
    const info = await docker.getContainer('ys-app-t1b').inspect();
    expect(info.Config.User).not.toMatch(/^(|0|root)(:|$)/);
  });

  it('stop removes the container; status/endpoint/logs are safe afterwards', async () => {
    await driver.start(spec('t1a'));
    await driver.stop('t1a');
    expect(await driver.status('t1a')).toBe('stopped');
    expect(await driver.endpoint('t1a')).toBeNull();
    expect(await driver.logs('t1a', 5)).toEqual([]);
    await driver.stop('t1a'); // idempotent
  });

  it('start replaces an existing container for the same app', async () => {
    await driver.start(spec('t1a'));
    await driver.start(spec('t1a'));
    expect(await driver.runningCount()).toContainEqual({ appId: 't1a', containers: 1 });
  });

  it('reports crashed for a non-zero exit', async () => {
    execFileSync('docker', ['build', '-q', '-t', 'ys-test-crash:1', '-'], {
      input: 'FROM busybox\nUSER 1000\nCMD ["sh","-c","exit 3"]\n',
    });
    try {
      await driver.start(spec('t1a', 'ys-test-crash:1'));
      let s = await driver.status('t1a');
      for (let i = 0; i < 30 && s !== 'crashed'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        s = await driver.status('t1a');
      }
      expect(s).toBe('crashed');
    } finally {
      await driver.stop('t1a');
      spawnSync('docker', ['rmi', '-f', 'ys-test-crash:1']);
    }
  });
});
