import { describe, expect, it } from 'vitest';
import { buildKubernetesManifests, namespaceFor } from '../../src/runtime/kubernetes-manifests.js';

const spec = {
  appId: '11111111-1111-4111-8111-111111111111',
  deploymentId: '22222222-2222-4222-8222-222222222222',
  ownerId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  image: 'registry.local/app1:v1',
  env: { FOO: 'bar' },
  limits: { memoryMb: 512, cpu: 0.5, pids: 256 },
  port: 8080,
};
/* eslint-disable @typescript-eslint/no-explicit-any */
const find = (kind: string): any => (buildKubernetesManifests(spec) as any[]).find((m) => m.kind === kind);

describe('buildKubernetesManifests', () => {
  it('matches snapshot', () => {
    expect(buildKubernetesManifests(spec)).toMatchSnapshot();
  });

  it('uses a per-owner namespace of the full owner id without dashes', () => {
    expect(namespaceFor(spec.ownerId)).toBe('ys-o-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d');
    for (const m of buildKubernetesManifests(spec) as any[]) {
      expect(m.kind === 'Namespace' ? m.metadata.name : m.metadata.namespace).toBe('ys-o-0a1b2c3d4e5f4a6b8c7d9e0f1a2b3c4d');
    }
  });

  it('hardens the pod', () => {
    const pod = find('Deployment').spec.template.spec;
    expect(pod.runtimeClassName).toBe('gvisor');
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    const c = pod.containers[0];
    expect(c.securityContext).toMatchObject({
      runAsNonRoot: true,
      privileged: false,
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
    expect(c.resources.limits).toMatchObject({ memory: '512Mi', cpu: '0.5' });
    expect(c.env).toContainEqual({ name: 'PORT', value: '8080' });
    expect(pod.volumes[0].emptyDir.sizeLimit).toBe('64Mi');
  });

  it('NetworkPolicy blocks metadata, SMTP, and other namespaces', () => {
    const np = find('NetworkPolicy').spec;
    expect(np.policyTypes).toEqual(['Ingress', 'Egress']);
    const internet = np.egress.find((r: any) => r.to[0].ipBlock?.cidr === '0.0.0.0/0');
    expect(internet.to[0].ipBlock.except).toContain('169.254.169.254/32');
    expect(internet.to[0].ipBlock.except).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']));
    const allowedPorts = np.egress.flatMap((r: any) => (r.ports ?? []).map((p: any) => p.port));
    expect(allowedPorts).not.toContain(25);
    // no rule allows traffic to arbitrary namespaces
    for (const r of np.egress) {
      for (const t of r.to) {
        if (t.namespaceSelector) expect(t.namespaceSelector.matchLabels).toEqual({ 'kubernetes.io/metadata.name': 'kube-system' });
      }
    }
    // ingress only from the system namespace
    expect(np.ingress).toHaveLength(1);
    expect(np.ingress[0].from[0].namespaceSelector.matchLabels['kubernetes.io/metadata.name']).toBe('ys-system');
  });

  it('includes Service and ResourceQuota', () => {
    expect(find('Service').spec.ports[0].port).toBe(8080);
    expect(find('ResourceQuota').spec.hard.pods).toBe('2');
  });
});

describe('manifest extras', () => {
  it('enforces restricted pod security, LimitRange, ephemeral-storage quota, and validates ids', () => {
    expect(find('Namespace').metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    expect(find('LimitRange').spec.limits[0].max.memory).toBe('512Mi');
    expect(find('ResourceQuota').spec.hard['limits.ephemeral-storage']).toBeDefined();
    expect(namespaceFor(spec.ownerId).length).toBeLessThanOrEqual(63);
    expect(() => buildKubernetesManifests({ ...spec, ownerId: 'x' })).toThrow(/ownerId/);
    expect(() => buildKubernetesManifests({ ...spec, appId: '../x' })).toThrow(/appId/);
  });
});
