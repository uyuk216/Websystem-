import { describe, expect, it } from 'vitest';
import { KubernetesDriver, type KubeApi, type KubePod, type KubeWorkload } from '../../src/runtime/kubernetes.js';
import type { AppRunSpec } from '../../src/runtime/driver.js';

const appId = '11111111-1111-4111-8111-111111111111';
const dep1 = '22222222-2222-4222-8222-222222222222';
const dep2 = '33333333-3333-4333-8333-333333333333';
const ownerId = '44444444-4444-4444-8444-444444444444';
const ns = 'ys-o-44444444444444448444444444444444';

const spec = (deploymentId: string): AppRunSpec => ({
  appId, deploymentId, ownerId, image: 'registry.local/app:1', env: { A: '1' },
  limits: { memoryMb: 512, cpu: 0.5, pids: 256 }, port: 8080,
});

/** In-memory fake of the cluster: applied objects become workloads; pods are set by the test. */
function fakeApi() {
  const applied: Array<{ kind: string; metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> } }> = [];
  const workloads = new Map<string, KubeWorkload>();
  let pods: KubePod[] = [];
  const deleted: string[] = [];
  const match = (labels: Record<string, string>, selector: string) =>
    selector.split(',').every((part) => {
      const [k, v] = part.split('=');
      return v === undefined ? k! in labels : labels[k!] === v;
    });
  const api: KubeApi = {
    async apply(obj) {
      const o = obj as (typeof applied)[number];
      applied.push(o);
      if (o.kind === 'Deployment') {
        workloads.set(`${o.metadata.namespace}/${o.metadata.name}`, {
          namespace: o.metadata.namespace!, name: o.metadata.name, labels: o.metadata.labels ?? {},
          port: Number(o.metadata.annotations?.['ys.port'] ?? 0),
        });
      }
    },
    async listWorkloads(sel) { return [...workloads.values()].filter((w) => match(w.labels, sel)); },
    async deleteWorkload(namespace, name) { deleted.push(`${namespace}/${name}`); workloads.delete(`${namespace}/${name}`); },
    async listPods(sel) { return pods.filter((p) => match(p.labels, sel)); },
    async podLogs(_ns, name) { return `log of ${name}\nsecond\n`; },
  };
  return { api, applied, deleted, setPods: (p: KubePod[]) => { pods = p; } };
}

const pod = (deploymentId: string, over: Partial<KubePod> = {}): KubePod => ({
  namespace: ns, name: `pod-${deploymentId.slice(0, 4)}`, labels: { 'ys.app': appId, 'ys.deployment': deploymentId },
  ready: true, crashed: false, created: 1, ...over,
});

describe('KubernetesDriver (mocked API)', () => {
  it('start applies namespace, deployment, service, policy, quota and limits with the port annotation', async () => {
    const f = fakeApi();
    const d = new KubernetesDriver({ api: f.api });
    const h = await d.start(spec(dep1));
    expect(h.containerId).toBe(`ys-app-${appId}-22222222`);
    expect(f.applied.map((o) => o.kind)).toEqual(['Namespace', 'Deployment', 'Service', 'NetworkPolicy', 'ResourceQuota', 'LimitRange']);
    const deployment = f.applied.find((o) => o.kind === 'Deployment')!;
    expect(deployment.metadata.annotations?.['ys.port']).toBe('8080');
    expect(deployment.metadata.labels).toEqual({ 'ys.app': appId, 'ys.deployment': dep1 });
  });

  it('status: stopped without a workload, starting without ready pods, crashed, running', async () => {
    const f = fakeApi();
    const d = new KubernetesDriver({ api: f.api });
    expect(await d.status(appId)).toBe('stopped');
    await d.start(spec(dep1));
    expect(await d.status(appId)).toBe('starting');
    f.setPods([pod(dep1, { ready: false, crashed: true })]);
    expect(await d.status(appId, dep1)).toBe('crashed');
    f.setPods([pod(dep1)]);
    expect(await d.status(appId, dep1)).toBe('running');
    expect(await d.status(appId, dep2)).toBe('stopped');
  });

  it('endpoint is the service DNS name of the ready deployment, null when not ready', async () => {
    const f = fakeApi();
    const d = new KubernetesDriver({ api: f.api });
    await d.start(spec(dep1));
    f.setPods([pod(dep1, { ready: false })]);
    expect(await d.endpoint(appId)).toBeNull();
    f.setPods([pod(dep1)]);
    expect(await d.endpoint(appId)).toEqual({ host: `ys-app-${appId}-22222222.${ns}.svc.cluster.local`, port: 8080 });
  });

  it('stopDeployment removes only that deployment; stop removes all', async () => {
    const f = fakeApi();
    const d = new KubernetesDriver({ api: f.api });
    await d.start(spec(dep1));
    await d.start(spec(dep2));
    await d.stopDeployment(appId, dep1);
    expect(f.deleted).toEqual([`${ns}/ys-app-${appId}-22222222`]);
    await d.stop(appId);
    expect(f.deleted).toEqual([`${ns}/ys-app-${appId}-22222222`, `${ns}/ys-app-${appId}-33333333`]);
    expect(await d.status(appId)).toBe('stopped');
  });

  it('logs come from the newest pod; runningCount counts ready pods per app', async () => {
    const f = fakeApi();
    const d = new KubernetesDriver({ api: f.api });
    expect(await d.logs(appId, 10)).toEqual([]);
    f.setPods([pod(dep1, { ready: false, created: 1 }), pod(dep2, { ready: false, created: 2 })]);
    expect(await d.logs(appId, 10)).toEqual(['log of pod-3333', 'second']);
    expect(await d.runningCount()).toEqual([]);
    f.setPods([pod(dep1), pod(dep2)]);
    expect(await d.runningCount()).toEqual([{ appId, containers: 2 }]);
  });

  it('rejects non-UUID ids before touching the cluster', async () => {
    const d = new KubernetesDriver({ api: fakeApi().api });
    await expect(d.stop('x,ys.app')).rejects.toThrow(/UUID/);
  });
});

describe('KubernetesDriver runtime class', () => {
  it('uses gvisor by default and omits it only with runtimeClass "none"', async () => {
    const rc = async (opts: { runtimeClass?: string }) => {
      const f = fakeApi();
      await new KubernetesDriver({ api: f.api, warn: () => {}, ...opts }).start(spec(dep1));
      const d = f.applied.find((o) => o.kind === 'Deployment') as unknown as { spec: { template: { spec: { runtimeClassName?: string } } } };
      return d.spec.template.spec.runtimeClassName;
    };
    expect(await rc({})).toBe('gvisor');
    expect(await rc({ runtimeClass: 'kata' })).toBe('kata');
    expect(await rc({ runtimeClass: 'none' })).toBeUndefined();
  });
});

describe('applyPath', () => {
  it('maps each manifest kind to its server-side apply URL', async () => {
    const { applyPath } = await import('../../src/runtime/kubernetes.js');
    const { buildKubernetesManifests } = await import('../../src/runtime/kubernetes-manifests.js');
    const paths = buildKubernetesManifests(spec(dep1)).map((o) => applyPath(o as Parameters<typeof applyPath>[0]));
    expect(paths).toEqual([
      `/api/v1/namespaces/${ns}?fieldManager=ys-runtime&force=true`,
      `/apis/apps/v1/namespaces/${ns}/deployments/ys-app-${appId}-22222222?fieldManager=ys-runtime&force=true`,
      `/api/v1/namespaces/${ns}/services/ys-app-${appId}-22222222?fieldManager=ys-runtime&force=true`,
      `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/ys-app-isolation?fieldManager=ys-runtime&force=true`,
      `/api/v1/namespaces/${ns}/resourcequotas/ys-owner-quota?fieldManager=ys-runtime&force=true`,
      `/api/v1/namespaces/${ns}/limitranges/ys-owner-limits?fieldManager=ys-runtime&force=true`,
    ]);
    expect(() => applyPath({ kind: 'Secret', metadata: { name: 'x' } })).toThrow(/unsupported/);
  });
});
