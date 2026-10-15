import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildImage } from '../../src/build/build.js';
import { detectStack } from '../../src/build/detect.js';

const dirs: string[] = [];
const tags: string[] = [];
const ctx = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'ys-build-'));
  dirs.push(d);
  for (const [k, v] of Object.entries(files)) writeFileSync(join(d, k), v);
  return d;
};
let n = 0;
const tag = () => { const t = `ys/test-build:${process.pid}-${n++}`; tags.push(t); return t; };
afterAll(() => {
  for (const t of tags) { try { execFileSync('docker', ['image', 'rm', '-f', t], { stdio: 'ignore' }); } catch { /* gone */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('buildImage', () => {
  it('builds a minimal node app and the container answers on $PORT', async () => {
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'a', scripts: { start: 'node server.js' } }),
      'server.js': 'require("http").createServer((q,r)=>r.end("hello")).listen(process.env.PORT||8080)',
    };
    const stack = detectStack(Object.keys(files), (p) => files[p] ?? null);
    if (!('dockerfile' in stack)) throw new Error('stack');
    const dir = ctx({ ...files, Dockerfile: stack.dockerfile });
    const t = tag();
    const r = await buildImage(dir, { tag: t, buildId: 'test-node' });
    expect(r).toMatchObject({ ok: true, imageRef: t });
    if (!r.ok) return;
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(execFileSync('docker', ['image', 'inspect', '--format', '{{.Config.User}}', t]).toString().trim()).toBe('node');
    // Same hardening as the runtime driver: non-root uid, read-only rootfs, only /tmp writable.
    const name = `ys-test-ro-${process.pid}`;
    execFileSync('docker', ['run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp:size=64m', '--user', '65534:65534',
      '--cap-drop', 'ALL', '-e', 'PORT=9191', t]);
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const out = execFileSync('docker', ['exec', name, 'wget', '-qO-', 'http://127.0.0.1:9191/']).toString();
      expect(out).toBe('hello');
    } finally { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); }
  }, 180_000);

  it('fails with build_failed and keeps the log on a broken build', async () => {
    const r = await buildImage(ctx({ Dockerfile: 'FROM alpine:3.20\nRUN echo boom-marker && exit 3\n' }), { tag: tag() });
    expect(r).toMatchObject({ ok: false, reason: 'build_failed' });
    expect(r.log).toContain('boom-marker');
  }, 120_000);

  it('stops an infinite loop at the timeout', async () => {
    const t0 = Date.now();
    const r = await buildImage(ctx({ Dockerfile: 'FROM alpine:3.20\nRUN while true; do :; done\n' }), { tag: tag(), timeoutMs: 8_000, buildId: 'test-timeout' });
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(60_000);
    const ids = execFileSync('docker', ['ps', '-aq']).toString().split('\n').filter(Boolean);
    for (const id of ids) {
      const cg = execFileSync('docker', ['inspect', '--format', '{{.HostConfig.CgroupParent}}', id]).toString().trim();
      expect(cg).not.toBe('ys-build-test-timeout');
    }
  }, 90_000);

  it('applies memory limit and the ys-build network to build steps', async () => {
    const r = await buildImage(ctx({ Dockerfile: 'FROM alpine:3.20\nRUN cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null; echo mem-done\n' }), { tag: tag(), buildId: 'test-mem' });
    expect(r.ok).toBe(true);
    expect(r.log).toContain('1073741824');
    const net = JSON.parse(execFileSync('docker', ['network', 'inspect', 'ys-build']).toString())[0];
    expect(net.Options['com.docker.network.bridge.enable_icc']).toBe('false');
  }, 120_000);

  it('rejects and removes an image over the size limit', async () => {
    const t = tag();
    const r = await buildImage(ctx({ Dockerfile: 'FROM alpine:3.20\nRUN head -c 3000000 /dev/zero > /big\n' }), { tag: t, maxImageBytes: 2_000_000 });
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(() => execFileSync('docker', ['image', 'inspect', t], { stdio: 'ignore' })).toThrow();
  }, 120_000);

  it('cuts off huge build output at maxLogBytes and fails', async () => {
    const r = await buildImage(ctx({ Dockerfile: 'FROM alpine:3.20\nRUN yes spam | head -c 5000000; sleep 30\n' }), { tag: tag(), maxLogBytes: 10_000 });
    expect(r).toMatchObject({ ok: false, reason: 'build_failed' });
    expect(Buffer.byteLength(r.log)).toBeLessThan(10_200);
    expect(r.log).toContain('log exceeded');
  }, 90_000);
});
