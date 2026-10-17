import { request as httpsRequest, type RequestOptions } from 'node:https';
import { assertUuid } from './driver.js';
import type { AppRunSpec, RunHandle, RuntimeDriver, RuntimeStatus } from './driver.js';
import { buildKubernetesManifests, workloadName } from './kubernetes-manifests.js';

export interface KubeWorkload {
  namespace: string;
  name: string;
  labels: Record<string, string>;
  port: number;
}

export interface KubePod {
  namespace: string;
  name: string;
  labels: Record<string, string>;
  ready: boolean;
  /** CrashLoopBackOff, or a container that terminated with a non-zero exit code. */
  crashed: boolean;
  /** Epoch ms. */
  created: number;
}

/** The slice of the Kubernetes API the driver needs; the default implementation wraps @kubernetes/client-node. */
export interface KubeApi {
  /** Server-side apply (idempotent create-or-update). */
  apply(obj: object): Promise<void>;
  /** Deployments across all namespaces matching the label selector. */
  listWorkloads(labelSelector: string): Promise<KubeWorkload[]>;
  /** Deletes the Deployment and Service named `name` (missing objects are ignored). */
  deleteWorkload(namespace: string, name: string): Promise<void>;
  listPods(labelSelector: string): Promise<KubePod[]>;
  podLogs(namespace: string, name: string, tailLines: number): Promise<string>;
}

const PORT_ANNOTATION = 'ys.port';

export interface KubernetesDriverOptions {
  api?: KubeApi;
  /** Cluster DNS suffix for Service endpoints. */
  clusterDomain?: string;
  /** Pod RuntimeClass; defaults to K8S_RUNTIME_CLASS or "gvisor". "none" omits it (development only). */
  runtimeClass?: string;
  warn?: (message: string) => void;
}

/**
 * Production driver: applies the manifests from buildKubernetesManifests and reaches apps through their Service.
 * The edge must run inside the cluster (namespace ys-system) so the Service DNS name resolves and the
 * NetworkPolicy admits it.
 */
export class KubernetesDriver implements RuntimeDriver {
  private apiPromise: Promise<KubeApi> | null;
  private readonly clusterDomain: string;
  private readonly runtimeClassName: string | null;

  constructor(options: KubernetesDriverOptions = {}) {
    this.apiPromise = options.api ? Promise.resolve(options.api) : null;
    this.clusterDomain = options.clusterDomain ?? 'cluster.local';
    const rc = options.runtimeClass ?? (process.env.K8S_RUNTIME_CLASS || 'gvisor');
    this.runtimeClassName = rc === 'none' ? null : rc;
    if (!this.runtimeClassName) {
      (options.warn ?? ((m) => console.warn(m)))('K8S_RUNTIME_CLASS=none: app pods run without gVisor (development only)');
    }
  }

  private api(): Promise<KubeApi> {
    this.apiPromise ??= createClientNodeApi().catch((err) => {
      this.apiPromise = null;
      throw err;
    });
    return this.apiPromise;
  }

  async start(spec: AppRunSpec): Promise<RunHandle> {
    const api = await this.api();
    const name = workloadName(spec.appId, spec.deploymentId);
    for (const obj of buildKubernetesManifests(spec, { runtimeClassName: this.runtimeClassName })) {
      const o = obj as { kind: string; metadata: { annotations?: Record<string, string> } };
      if (o.kind === 'Deployment') {
        o.metadata.annotations = { ...o.metadata.annotations, [PORT_ANNOTATION]: String(spec.port) };
      }
      await api.apply(obj);
    }
    return { appId: spec.appId, deploymentId: spec.deploymentId, containerId: name };
  }

  private selector(appId: string, deploymentId?: string): string {
    assertUuid(appId, 'appId');
    if (!deploymentId) return `ys.app=${appId}`;
    assertUuid(deploymentId, 'deploymentId');
    return `ys.app=${appId},ys.deployment=${deploymentId}`;
  }

  private async removeAll(selector: string): Promise<void> {
    const api = await this.api();
    const list = await api.listWorkloads(selector);
    await Promise.all(list.map((w) => api.deleteWorkload(w.namespace, w.name)));
  }

  async stop(appId: string): Promise<void> {
    await this.removeAll(this.selector(appId));
  }

  async stopDeployment(appId: string, deploymentId: string): Promise<void> {
    await this.removeAll(this.selector(appId, deploymentId));
  }

  /** Prefers a ready pod, otherwise the newest. */
  private async pickPod(appId: string, deploymentId?: string): Promise<KubePod | undefined> {
    const pods = (await (await this.api()).listPods(this.selector(appId, deploymentId))).sort((a, b) => b.created - a.created);
    return pods.find((p) => p.ready) ?? pods[0];
  }

  async status(appId: string, deploymentId?: string): Promise<RuntimeStatus> {
    const api = await this.api();
    const selector = this.selector(appId, deploymentId);
    if ((await api.listWorkloads(selector)).length === 0) return 'stopped';
    const pod = await this.pickPod(appId, deploymentId);
    if (!pod) return 'starting';
    if (pod.ready) return 'running';
    return pod.crashed ? 'crashed' : 'starting';
  }

  async endpoint(appId: string, deploymentId?: string): Promise<{ host: string; port: number } | null> {
    const api = await this.api();
    const pod = await this.pickPod(appId, deploymentId);
    if (!pod?.ready) return null;
    const dep = pod.labels['ys.deployment'];
    if (!dep) return null;
    const w = (await api.listWorkloads(this.selector(appId, dep)))[0];
    if (!w || !Number.isInteger(w.port) || w.port <= 0) return null;
    return { host: `${w.name}.${w.namespace}.svc.${this.clusterDomain}`, port: w.port };
  }

  async logs(appId: string, tail: number, deploymentId?: string): Promise<string[]> {
    const pod = await this.pickPod(appId, deploymentId);
    if (!pod) return [];
    const text = await (await this.api()).podLogs(pod.namespace, pod.name, tail);
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  }

  async runningCount(): Promise<Array<{ appId: string; containers: number }>> {
    const pods = await (await this.api()).listPods('ys.app');
    const counts = new Map<string, number>();
    for (const p of pods) {
      const id = p.labels['ys.app'];
      if (id && p.ready) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts].map(([appId, containers]) => ({ appId, containers }));
  }
}

const FIELD_MANAGER = 'ys-runtime';

/** REST path of each kind buildKubernetesManifests produces. */
const RESOURCE: Record<string, { base: string; plural: string; namespaced: boolean }> = {
  Namespace: { base: '/api/v1', plural: 'namespaces', namespaced: false },
  Deployment: { base: '/apis/apps/v1', plural: 'deployments', namespaced: true },
  Service: { base: '/api/v1', plural: 'services', namespaced: true },
  NetworkPolicy: { base: '/apis/networking.k8s.io/v1', plural: 'networkpolicies', namespaced: true },
  ResourceQuota: { base: '/api/v1', plural: 'resourcequotas', namespaced: true },
  LimitRange: { base: '/api/v1', plural: 'limitranges', namespaced: true },
};

/** URL path for a server-side apply of `obj`. */
export function applyPath(obj: { kind: string; metadata: { name: string; namespace?: string } }): string {
  const r = RESOURCE[obj.kind];
  if (!r) throw new Error(`unsupported kind: ${obj.kind}`);
  const ns = r.namespaced ? `/namespaces/${encodeURIComponent(obj.metadata.namespace ?? '')}` : '';
  return `${r.base}${ns}/${r.plural}/${encodeURIComponent(obj.metadata.name)}?fieldManager=${FIELD_MANAGER}&force=true`;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number; body?: { code?: number } };
  return e.code === 404 || e.statusCode === 404 || e.body?.code === 404;
}

/** Loads the in-cluster config (or KUBECONFIG / ~/.kube/config when running outside the cluster). */
async function createClientNodeApi(): Promise<KubeApi> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  return {
    // Sent as raw JSON: the client's typed serializer drops fields it names differently (NetworkPolicy
    // `from` is `_from` in its models), which silently turned the isolation policy into allow-all.
    async apply(obj) {
      const cluster = kc.getCurrentCluster();
      if (!cluster) throw new Error('no current Kubernetes cluster in the kubeconfig');
      const url = new URL(applyPath(obj as Parameters<typeof applyPath>[0]), cluster.server);
      const body = JSON.stringify(obj);
      const opts: RequestOptions = {
        method: 'PATCH', hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
        headers: { 'content-type': 'application/apply-patch+yaml', accept: 'application/json', 'content-length': Buffer.byteLength(body) },
      };
      await kc.applyToHTTPSOptions(opts);
      await new Promise<void>((resolve, reject) => {
        const req = httpsRequest(opts, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { if (text.length < 4096) text += c; });
          res.on('end', () => ((res.statusCode ?? 500) < 300 ? resolve() : reject(new Error(`apply ${(obj as { kind: string }).kind} failed (${res.statusCode}): ${text}`))));
        });
        req.on('error', reject);
        req.end(body);
      });
    },
    async listWorkloads(labelSelector) {
      const res = await apps.listDeploymentForAllNamespaces({ labelSelector });
      return res.items.map((d) => ({
        namespace: d.metadata?.namespace ?? '',
        name: d.metadata?.name ?? '',
        labels: d.metadata?.labels ?? {},
        port: Number(d.metadata?.annotations?.[PORT_ANNOTATION] ?? 0),
      }));
    },
    async deleteWorkload(namespace, name) {
      for (const del of [
        () => apps.deleteNamespacedDeployment({ name, namespace, propagationPolicy: 'Foreground' }),
        () => core.deleteNamespacedService({ name, namespace }),
      ]) {
        try {
          await del();
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
    },
    async listPods(labelSelector) {
      const res = await core.listPodForAllNamespaces({ labelSelector });
      return res.items.map((p) => {
        const statuses = p.status?.containerStatuses ?? [];
        return {
          namespace: p.metadata?.namespace ?? '',
          name: p.metadata?.name ?? '',
          labels: p.metadata?.labels ?? {},
          ready: p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
          crashed: statuses.some(
            (s) =>
              s.state?.waiting?.reason === 'CrashLoopBackOff' ||
              (s.state?.terminated !== undefined && s.state.terminated.exitCode !== 0) ||
              (s.lastState?.terminated !== undefined && s.lastState.terminated.exitCode !== 0 && !s.ready),
          ),
          created: p.metadata?.creationTimestamp ? new Date(p.metadata.creationTimestamp).getTime() : 0,
        };
      });
    },
    async podLogs(namespace, name, tailLines) {
      try {
        return await core.readNamespacedPodLog({ name, namespace, tailLines });
      } catch (err) {
        if (isNotFound(err)) return '';
        throw err;
      }
    },
  };
}
