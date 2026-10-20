import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const available = spawnSync('docker', ['inspect', 'ys-pii-db'], { stdio: 'ignore' }).status === 0;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

describe.skipIf(!available)('ys-pii-db network isolation', { timeout: 60_000 }, () => {
  it('sits only on ys-piinet and publishes its port on loopback only', () => {
    const nets = docker('inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}', 'ys-pii-db').split(/\s+/).filter(Boolean);
    expect(nets).toEqual(['ys-piinet']);
    const ports = JSON.parse(docker('inspect', '-f', '{{json .NetworkSettings.Ports}}', 'ys-pii-db')) as Record<string, { HostIp: string }[] | null>;
    const bindings = Object.values(ports).flatMap((b) => b ?? []);
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every((b) => b.HostIp === '127.0.0.1')).toBe(true);
  });

  it('does not resolve from the main stack network (where the platform database and API-side containers live)', () => {
    const mainNet = docker('inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', 'websystem-dev-postgres-1');
    expect(mainNet).not.toBe('ys-piinet');
    const r = spawnSync('docker', ['run', '--rm', '--network', mainNet, 'busybox', 'nc', '-z', '-w', '3', 'ys-pii-db', '5432'], { encoding: 'utf8', timeout: 45_000 });
    expect(r.status).not.toBe(0);
    // Known caveat (not asserted): because the port is published on the host loopback, Docker's published-port rule also
    // lets a container on another bridge reach the container IP directly. Production separates hosts/networks (phase 8).
  });
});
