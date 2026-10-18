import { request as httpsRequest, type RequestOptions } from 'node:https';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { applyPath, resourcePath } from '../runtime/kubernetes.js';
import { assertUuid } from '../runtime/driver.js';
import type { DatabaseDriver, DatabaseEndpoint, DatabaseSpec, DatabaseStatus } from './driver.js';
import { buildDatabaseManifests, databaseClusterName, databaseNamespaceFor, type DatabaseManifestOptions } from './kubernetes-manifests.js';
import { PostgresAdmin, type ExecResult } from './postgres-admin.js';

type K8sObject = { kind: string; metadata: { name: string; namespace?: string } };

/** The Kubernetes operations the database driver needs; the default implementation uses the kubeconfig. */
export interface DatabaseKubeApi {
  apply(obj: object): Promise<void>;
  /** Deletes one object; missing objects are ignored. */
  remove(kind: string, namespace: string | undefined, name: string): Promise<void>;
  /** Pods of a CloudNativePG cluster: name, ready, and whether it is the primary. */
  clusterPods(namespace: string, cluster: string): Promise<Array<{ name: string; ready: boolean; primary: boolean }>>;
  exec(namespace: string, pod: string, container: string, cmd: string[], stdin?: string | Readable): Promise<ExecResult>;
  execStream(namespace: string, pod: string, container: string, cmd: string[]): Promise<Readable>;
}

export interface KubernetesDatabaseOptions extends DatabaseManifestOptions {
  api?: DatabaseKubeApi;
  clusterDomain?: string;
  readyTimeoutMs?: number;
  /** appId → ownerId, so per-app calls can find the namespace (the driver interface is keyed by app id). */
  ownerOf: (appId: string) => Promise<string>;
}

/**
 * Production driver: one CloudNativePG Cluster per app in the owner's database namespace. Administration (size,
 * write mode, dumps, restores) runs through the pod exec API in the primary's `postgres` container, so it works
 * from outside the cluster too.
 */
export class KubernetesDatabaseDriver extends PostgresAdmin implements DatabaseDriver {
  private apiPromise: Promise<DatabaseKubeApi> | null;
  private readonly opts: KubernetesDatabaseOptions;

  constructor(opts: KubernetesDatabaseOptions) {
    super();
    this.opts = opts;
    this.apiPromise = opts.api ? Promise.resolve(opts.api) : null;
  }

  private api(): Promise<DatabaseKubeApi> {
    this.apiPromise ??= createDatabaseKubeApi().catch((e) => { this.apiPromise = null; throw e; });
    return this.apiPromise;
  }

  private async where(appId: string): Promise<{ ns: string; cluster: string }> {
    assertUuid(appId, 'appId');
    return { ns: databaseNamespaceFor(await this.opts.ownerOf(appId)), cluster: databaseClusterName(appId) };
  }

  private async primary(appId: string): Promise<{ ns: string; pod: string }> {
    const { ns, cluster } = await this.where(appId);
    const pods = await (await this.api()).clusterPods(ns, cluster);
    const p = pods.find((x) => x.primary && x.ready);
    if (!p) throw new Error('database primary is not ready');
    return { ns, pod: p.name };
  }

  protected async exec(appId: string, cmd: string[], stdin?: string | Readable): Promise<ExecResult> {
    const { ns, pod } = await this.primary(appId);
    return (await this.api()).exec(ns, pod, 'postgres', cmd, stdin);
  }

  protected async execStream(appId: string, cmd: string[]): Promise<Readable> {
    const { ns, pod } = await this.primary(appId);
    return (await this.api()).execStream(ns, pod, 'postgres', cmd);
  }

  async create(spec: DatabaseSpec): Promise<void> {
    const api = await this.api();
    for (const obj of buildDatabaseManifests(spec, this.opts)) await api.apply(obj);
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 5 * 60_000);
    while ((await this.status(spec.appId)) !== 'running') {
      if (Date.now() > deadline) throw new Error('database did not become ready in time');
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Same role settings as the Docker driver (connection limit, no superuser, PUBLIC revoked).
    await this.ensureRoleAndDatabase(spec);
  }

  async remove(appId: string): Promise<void> {
    const api = await this.api();
    const ownerId = await this.opts.ownerOf(appId);
    // Every object buildDatabaseManifests can create for this app (the per-owner namespace is shared and kept).
    const all = buildDatabaseManifests(
      { appId, ownerId, database: 'x', user: 'x', password: 'x', limits: { connections: 1, memoryMb: 1 } },
      { backupStore: { destinationPath: 's3://x', accessKeyId: '', secretAccessKey: '' } },
    ) as K8sObject[];
    for (const o of all) if (o.kind !== 'Namespace') await api.remove(o.kind, o.metadata.namespace, o.metadata.name);
  }

  async status(appId: string): Promise<DatabaseStatus> {
    const { ns, cluster } = await this.where(appId);
    const pods = await (await this.api()).clusterPods(ns, cluster);
    if (pods.length === 0) return 'missing';
    if (!pods.some((p) => p.primary && p.ready)) return 'starting';
    // Ready from Kubernetes' view; also make sure the server answers (initdb may still be running).
    const r = await this.exec(appId, ['pg_isready', '-q']).catch(() => ({ code: 1 }));
    return r.code === 0 ? 'running' : 'starting';
  }

  async endpoint(appId: string): Promise<DatabaseEndpoint> {
    const { ns, cluster } = await this.where(appId);
    return { host: `${cluster}-rw.${ns}.svc.${this.opts.clusterDomain ?? 'cluster.local'}`, port: 5432 };
  }
}

function isNotFound(e: unknown): boolean {
  return (e as { status?: number }).status === 404;
}

/** kubeconfig-backed implementation (raw JSON for apply/delete; the client's Exec for pod exec). */
async function createDatabaseKubeApi(): Promise<DatabaseKubeApi> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const exec = new k8s.Exec(kc);

  const call = async (method: string, path: string, body?: string, contentType?: string): Promise<{ status: number; text: string }> => {
    const cluster = kc.getCurrentCluster();
    if (!cluster) throw new Error('no current Kubernetes cluster in the kubeconfig');
    const url = new URL(path, cluster.server);
    const opts: RequestOptions = {
      method, hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search,
      headers: { accept: 'application/json', ...(body ? { 'content-type': contentType ?? 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    };
    await kc.applyToHTTPSOptions(opts);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(opts, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (text.length < 8192) text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
  };

  const run = (ns: string, pod: string, container: string, cmd: string[], stdout: Writable, stderr: Writable, stdin: Readable | null) =>
    new Promise<number>((resolve, reject) => {
      exec.exec(ns, pod, container, cmd, stdout, stderr, stdin, false, (st) => {
        const code = st.status === 'Success' ? 0 : Number(st.details?.causes?.find((c) => c.reason === 'ExitCode')?.message ?? 1);
        resolve(code);
      }).then((ws) => { ws.on('error', reject); }, reject);
    });

  return {
    async apply(obj) {
      const r = await call('PATCH', applyPath(obj as K8sObject), JSON.stringify(obj), 'application/apply-patch+yaml');
      if (r.status >= 300) throw new Error(`apply ${(obj as K8sObject).kind} failed (${r.status}): ${r.text}`);
    },
    async remove(kind, namespace, name) {
      const r = await call('DELETE', resourcePath(kind, namespace, name));
      if (r.status >= 300 && r.status !== 404) throw Object.assign(new Error(`delete ${kind} failed (${r.status}): ${r.text}`), { status: r.status });
    },
    async clusterPods(namespace, cluster) {
      try {
        const res = await core.listNamespacedPod({ namespace, labelSelector: `cnpg.io/cluster=${cluster}` });
        return res.items.map((p) => ({
          name: p.metadata?.name ?? '',
          ready: p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false,
          primary: p.metadata?.labels?.['cnpg.io/instanceRole'] === 'primary' || p.metadata?.labels?.role === 'primary',
        }));
      } catch (e) {
        if (isNotFound(e) || (e as { code?: number }).code === 404) return [];
        throw e;
      }
    },
    async exec(ns, pod, container, cmd, stdin) {
      let out = '';
      let err = '';
      const sink = (append: (s: string) => void) => new Writable({ write(c: Buffer, _e, cb) { append(c.toString()); cb(); } });
      let input: Readable | null = null;
      if (typeof stdin === 'string') { const p = new PassThrough(); p.end(stdin); input = p; } else if (stdin) input = stdin;
      const code = await run(ns, pod, container, cmd, sink((s) => { if (out.length < 1 << 20) out += s; }), sink((s) => { if (err.length < 1 << 16) err += s; }), input);
      return { code, out, err };
    },
    async execStream(ns, pod, container, cmd) {
      const out = new PassThrough();
      let err = '';
      const stderr = new Writable({ write(c: Buffer, _e, cb) { if (err.length < 4096) err += c.toString(); cb(); } });
      const stdout = new Writable({ write(c: Buffer, _e, cb) { out.write(c, cb); } });
      run(ns, pod, container, cmd, stdout, stderr, null).then(
        (code) => { if (code === 0) out.end(); else out.destroy(new Error(`${cmd[0]} failed: ${err.trim()}`)); },
        (e: unknown) => out.destroy(e as Error),
      );
      return out;
    },
  };
}
