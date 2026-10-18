import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { KubernetesDatabaseDriver, type DatabaseKubeApi } from '../../src/database/kubernetes.js';
import { buildDatabaseManifests, databaseClusterName, databaseNamespaceFor } from '../../src/database/kubernetes-manifests.js';
import { namespaceFor } from '../../src/runtime/kubernetes-manifests.js';

const appId = '11111111-1111-4111-8111-111111111111';
const ownerId = '44444444-4444-4444-8444-444444444444';
const spec = { appId, ownerId, database: 'app_1111', user: 'app_1111', password: 'pw', limits: { connections: 10, memoryMb: 256 } };
const ns = databaseNamespaceFor(ownerId);
const name = databaseClusterName(appId);

type Obj = { kind: string; metadata: { name: string; namespace?: string }; spec?: Record<string, unknown> };

function fake(o: { ready?: boolean } = {}) {
  const applied: Obj[] = [];
  const removed: string[] = [];
  const execs: Array<{ pod: string; cmd: string[]; stdin?: string }> = [];
  let pods: Array<{ name: string; ready: boolean; primary: boolean }> = [];
  const api: DatabaseKubeApi = {
    async apply(obj) { applied.push(obj as Obj); if ((obj as Obj).kind === 'Cluster') pods = [{ name: `${name}-1`, ready: o.ready ?? true, primary: true }]; },
    async remove(kind, namespace, n) { removed.push(`${kind}/${namespace ?? ''}/${n}`); if (kind === 'Cluster') pods = []; },
    async clusterPods() { return pods; },
    async exec(_ns, pod, _c, cmd, stdin) {
      execs.push({ pod, cmd, ...(typeof stdin === 'string' ? { stdin } : {}) });
      if (cmd[0] === 'psql' && typeof stdin === 'string' && stdin.includes('pg_database_size')) return { code: 0, out: '12345\n', err: '' };
      return { code: 0, out: '', err: '' };
    },
    async execStream() { return Readable.from([Buffer.from('dump')]); },
  };
  return { api, applied, removed, execs };
}

const driver = (f: ReturnType<typeof fake>, extra: Partial<ConstructorParameters<typeof KubernetesDatabaseDriver>[0]> = {}) =>
  new KubernetesDatabaseDriver({ api: f.api, ownerOf: async () => ownerId, readyTimeoutMs: 300, ...extra });

describe('database manifests (CloudNativePG)', () => {
  it('builds namespace, credentials, cluster and the two network rules', () => {
    const objs = buildDatabaseManifests(spec) as Obj[];
    expect(objs.map((o) => o.kind)).toEqual(['Namespace', 'Namespace', 'Secret', 'Cluster', 'NetworkPolicy', 'NetworkPolicy']);
    // The app namespace is ensured too: a database can be added before the app ever started.
    expect(objs.filter((o) => o.kind === 'Namespace').map((o) => o.metadata.name)).toEqual([namespaceFor(ownerId), ns]);
    const cluster = objs.find((o) => o.kind === 'Cluster')!;
    expect(cluster.metadata).toMatchObject({ name, namespace: ns });
    expect(cluster.spec).toMatchObject({ instances: 1, enableSuperuserAccess: false, bootstrap: { initdb: { database: 'app_1111', owner: 'app_1111', secret: { name: `${name}-app` } } } });
    expect(cluster.spec).not.toHaveProperty('backup');
    const [ingress, egress] = objs.filter((o) => o.kind === 'NetworkPolicy') as Array<Obj & { spec: { ingress?: unknown[]; egress?: unknown[] } }>;
    // Only this app's pods (in the owner's app namespace) reach 5432; the operator reaches 8000.
    expect(ingress!.metadata.namespace).toBe(ns);
    expect(JSON.stringify(ingress!.spec.ingress![0])).toContain(`"kubernetes.io/metadata.name":"${namespaceFor(ownerId)}"`);
    expect(JSON.stringify(ingress!.spec.ingress![0])).toContain(`"ys.app":"${appId}"`);
    expect(JSON.stringify(ingress!.spec.ingress![1])).toContain('cnpg-system');
    expect(egress!.metadata.namespace).toBe(namespaceFor(ownerId));
    expect(JSON.stringify(egress!.spec.egress)).toContain(`"cnpg.io/cluster":"${name}"`);
  });

  it('adds continuous backups kept 7 days when a backup store is given (credentials in a Secret)', () => {
    const objs = buildDatabaseManifests(spec, { backupStore: { destinationPath: 's3://bk/', endpointURL: 'http://minio:9000', accessKeyId: 'AK', secretAccessKey: 'SK' } }) as Obj[];
    const cluster = objs.find((o) => o.kind === 'Cluster')!;
    expect(cluster.spec!.backup).toMatchObject({ retentionPolicy: '7d', barmanObjectStore: { destinationPath: `s3://bk/${name}`, endpointURL: 'http://minio:9000' } });
    expect(JSON.stringify(cluster)).not.toContain('SK');
    expect(objs.filter((o) => o.kind === 'Secret')).toHaveLength(2);
  });
});

describe('KubernetesDatabaseDriver (mocked API)', () => {
  it('create applies the manifests, waits for the primary and sets up the role through pod exec', async () => {
    const f = fake();
    await driver(f).create(spec);
    expect(f.applied.map((o) => o.kind)).toEqual(['Namespace', 'Namespace', 'Secret', 'Cluster', 'NetworkPolicy', 'NetworkPolicy']);
    const roleSql = f.execs.find((e) => e.stdin?.includes('CONNECTION LIMIT 10'));
    expect(roleSql?.pod).toBe(`${name}-1`);
    expect(roleSql?.cmd.slice(0, 3)).toEqual(['psql', '-U', 'postgres']);
  });

  it('create times out when the primary never becomes ready', async () => {
    await expect(driver(fake({ ready: false })).create(spec)).rejects.toThrow(/ready in time/);
  });

  it('status, endpoint, size, backup and remove', async () => {
    const f = fake();
    const d = driver(f);
    expect(await d.status(appId)).toBe('missing');
    await d.create(spec);
    expect(await d.status(appId)).toBe('running');
    expect(await d.endpoint(appId)).toEqual({ host: `${name}-rw.${ns}.svc.cluster.local`, port: 5432 });
    expect(await d.sizeBytes(appId, 'app_1111')).toBe(12345);
    const chunks: Buffer[] = [];
    for await (const c of await d.backup(appId, 'app_1111')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('dump');
    await d.remove(appId);
    expect(f.removed).toContain(`Cluster/${ns}/${name}`);
    expect(f.removed).toContain(`NetworkPolicy/${namespaceFor(ownerId)}/${name}-egress`);
    expect(f.removed.some((r) => r.startsWith('Namespace/'))).toBe(false); // shared by the owner's other databases
    expect(await d.status(appId)).toBe('missing');
  });
});
