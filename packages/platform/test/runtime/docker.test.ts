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
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const D1 = '11111111-0000-4000-8000-000000000001';
const D2 = '22222222-0000-4000-8000-000000000002';
const OWNER = 'cccccccc-0000-4000-8000-00000000000c';
const ids = [A, B];

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

  const spec = (appId: string, image = IMAGE, deploymentId = D1) => ({
    appId,
    deploymentId,
    ownerId: OWNER,
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
    const handle = await driver.start(spec(A));
    expect(handle.appId).toBe(A);
    const ep = await driver.endpoint(A);
    expect(ep?.host).toBe('127.0.0.1');
    expect(await waitOk(`http://127.0.0.1:${ep!.port}/`)).toContain('hello-from-app');
    expect(await driver.status(A)).toBe('running');
    expect(await driver.logs(A, 10)).toContain('started-up');
    expect(await driver.runningCount()).toContainEqual({ appId: A, containers: 1 });
  });

  it('applies the isolation settings', async () => {
    await driver.start(spec(A));
    const info = await docker.getContainer(`ys-app-${A}-11111111`).inspect();
    const hc = info.HostConfig;
    expect(info.Config.Labels['ys.app']).toBe(A);
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
    expect(info.Config.User).toBe('65534:65534');
    for (const b of Object.values((hc.PortBindings ?? {}) as Record<string, Array<{ HostIp: string }>>)) {
      expect(b.every((x) => x.HostIp === '127.0.0.1')).toBe(true);
    }
    expect(info.Config.Env).toContain('PORT=8080');
  });

  it.each(['0', '00', '0:0', 'root:root', 'root'])('forces uid 65534 when the image USER is %s', async (u) => {
    const img = `ys-test-root-${u.replace(/\W/g, '_')}:1`;
    execFileSync('docker', ['build', '-q', '-t', img, '-'], {
      input: DOCKERFILE.replace('USER 1000:1000', `USER ${u}`),
    });
    try {
      await driver.start(spec(B, img));
      const info = await docker.getContainer(`ys-app-${B}-11111111`).inspect();
      expect(info.Config.User).toBe('65534:65534');
      const out = execFileSync('docker', ['exec', info.Id, 'id', '-u']).toString().trim();
      expect(out).toBe('65534');
    } finally {
      await driver.stop(B);
      spawnSync('docker', ['rmi', '-f', img]);
    }
  });

  it('runs two deployments side by side and stops them independently', async () => {
    await driver.start(spec(A, IMAGE, D1));
    await driver.start(spec(A, IMAGE, D2));
    expect(await driver.runningCount()).toContainEqual({ appId: A, containers: 2 });
    const e1 = await driver.endpoint(A, D1);
    const e2 = await driver.endpoint(A, D2);
    expect(e1!.port).not.toBe(e2!.port);
    await driver.stopDeployment(A, D1);
    expect(await driver.endpoint(A, D1)).toBeNull();
    expect(await driver.status(A, D2)).toBe('running');
    await driver.stop(A);
    expect(await driver.status(A)).toBe('stopped');
  });

  it('ys-apps disables inter-container communication', async () => {
    const net = await docker.getNetwork(APPS_NETWORK).inspect();
    expect(net.Options?.['com.docker.network.bridge.enable_icc']).toBe('false');
    await driver.start(spec(A));
    await driver.start(spec(B));
    const bInfo = await docker.getContainer(`ys-app-${B}-11111111`).inspect();
    const ip = bInfo.NetworkSettings.Networks[APPS_NETWORK]!.IPAddress;
    const r = spawnSync('docker', ['exec', `ys-app-${A}-11111111`, 'wget', '-T', '2', '-qO-', `http://${ip}:8080/`]);
    expect(r.status).not.toBe(0);
  });

  it('removes the partial container when start fails', async () => {
    execFileSync('docker', ['build', '-q', '-t', 'ys-test-badcmd:1', '-'], {
      input: 'FROM busybox\nENTRYPOINT ["/nonexistent"]\n',
    });
    try {
      await expect(driver.start(spec(A, 'ys-test-badcmd:1'))).rejects.toThrow();
      const left = await docker.listContainers({ all: true, filters: { label: [`ys.app=${A}`] } });
      expect(left).toHaveLength(0);
    } finally {
      spawnSync('docker', ['rmi', '-f', 'ys-test-badcmd:1']);
    }
  });

  it('rejects non-UUID ids', async () => {
    await expect(driver.start({ ...spec(A), appId: '../x' })).rejects.toThrow(/appId/);
    await expect(driver.start({ ...spec(A), ownerId: 'x' })).rejects.toThrow(/ownerId/);
  });

  it('stop removes the container; status/endpoint/logs are safe afterwards', async () => {
    await driver.start(spec(A));
    await driver.stop(A);
    expect(await driver.status(A)).toBe('stopped');
    expect(await driver.endpoint(A)).toBeNull();
    expect(await driver.logs(A, 5)).toEqual([]);
    await driver.stop(A); // idempotent
  });

  it('reports crashed for a non-zero exit', async () => {
    execFileSync('docker', ['build', '-q', '-t', 'ys-test-crash:1', '-'], {
      input: 'FROM busybox\nUSER 1000\nCMD ["sh","-c","exit 3"]\n',
    });
    try {
      await driver.start(spec(A, 'ys-test-crash:1'));
      let s = await driver.status(A);
      for (let i = 0; i < 30 && s !== 'crashed'; i++) {
        await new Promise((r) => setTimeout(r, 200));
        s = await driver.status(A);
      }
      expect(s).toBe('crashed');
    } finally {
      await driver.stop(A);
      spawnSync('docker', ['rmi', '-f', 'ys-test-crash:1']);
    }
  });
});
