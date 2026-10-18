import { assertUuid } from '../runtime/driver.js';
import { namespaceFor, ownerNamespaceManifest } from '../runtime/kubernetes-manifests.js';
import type { DatabaseSpec } from './driver.js';

/** Databases live in a per-owner namespace of their own (the app namespace only lets apps reach the internet). */
export function databaseNamespaceFor(ownerId: string): string {
  assertUuid(ownerId, 'ownerId');
  return `ys-d-${ownerId.replace(/-/g, '').toLowerCase()}`;
}

/** CloudNativePG cluster name; its read-write Service is `<name>-rw`. */
export function databaseClusterName(appId: string): string {
  assertUuid(appId, 'appId');
  return `ys-db-${appId.replace(/-/g, '').slice(0, 12)}`;
}

export interface DatabaseBackupStore {
  /** e.g. s3://user-db-backups */
  destinationPath: string;
  endpointURL?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface DatabaseManifestOptions {
  instances?: number;
  storageSize?: string;
  /** Continuous WAL archiving and base backups (CloudNativePG), kept for 7 days. */
  backupStore?: DatabaseBackupStore;
}

/**
 * Everything for one app database. Network rules: only this app's pods (in the owner's app namespace) reach the
 * database on 5432, plus the CloudNativePG operator and the cluster's own instances; the app's namespace gets an
 * egress rule for exactly that.
 */
export function buildDatabaseManifests(spec: DatabaseSpec, opts: DatabaseManifestOptions = {}): object[] {
  const ns = databaseNamespaceFor(spec.ownerId);
  const appNs = namespaceFor(spec.ownerId);
  const name = databaseClusterName(spec.appId);
  const labels = { 'ys.app': spec.appId, 'ys.db': name };
  const clusterPods = { 'cnpg.io/cluster': name };
  const objects: object[] = [
    // The app namespace holds the egress rule below and may not exist yet (no app started so far).
    ownerNamespaceManifest(spec.ownerId),
    {
      apiVersion: 'v1', kind: 'Namespace',
      metadata: { name: ns, labels: { 'ys.owner': ns, 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest' } },
    },
    {
      apiVersion: 'v1', kind: 'Secret', type: 'kubernetes.io/basic-auth',
      metadata: { name: `${name}-app`, namespace: ns, labels },
      stringData: { username: spec.user, password: spec.password },
    },
  ];
  if (opts.backupStore) {
    objects.push({
      apiVersion: 'v1', kind: 'Secret',
      metadata: { name: `${name}-backup`, namespace: ns, labels },
      stringData: { ACCESS_KEY_ID: opts.backupStore.accessKeyId, ACCESS_SECRET_KEY: opts.backupStore.secretAccessKey },
    });
  }
  objects.push({
    apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster',
    metadata: { name, namespace: ns, labels },
    spec: {
      instances: opts.instances ?? 1,
      enableSuperuserAccess: false,
      storage: { size: opts.storageSize ?? '1Gi' },
      resources: { requests: { memory: `${spec.limits.memoryMb}Mi` }, limits: { memory: `${spec.limits.memoryMb}Mi` } },
      postgresql: { parameters: { max_connections: String(Math.max(20, spec.limits.connections * 3)) } },
      bootstrap: { initdb: { database: spec.database, owner: spec.user, secret: { name: `${name}-app` } } },
      ...(opts.backupStore ? {
        backup: {
          retentionPolicy: '7d',
          barmanObjectStore: {
            destinationPath: `${opts.backupStore.destinationPath.replace(/\/+$/, '')}/${name}`,
            ...(opts.backupStore.endpointURL ? { endpointURL: opts.backupStore.endpointURL } : {}),
            s3Credentials: {
              accessKeyId: { name: `${name}-backup`, key: 'ACCESS_KEY_ID' },
              secretAccessKey: { name: `${name}-backup`, key: 'ACCESS_SECRET_KEY' },
            },
          },
        },
      } : {}),
    },
  });
  objects.push(
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: `${name}-ingress`, namespace: ns, labels },
      spec: {
        podSelector: { matchLabels: clusterPods },
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': appNs } }, podSelector: { matchLabels: { 'ys.app': spec.appId } } }],
            ports: [{ protocol: 'TCP', port: 5432 }],
          },
          // The operator (status, management) and the cluster's own instances (replication).
          { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'cnpg-system' } } }], ports: [{ protocol: 'TCP', port: 8000 }, { protocol: 'TCP', port: 5432 }] },
          { from: [{ podSelector: { matchLabels: clusterPods } }], ports: [{ protocol: 'TCP', port: 5432 }, { protocol: 'TCP', port: 8000 }] },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: { name: `${name}-egress`, namespace: appNs, labels },
      spec: {
        podSelector: { matchLabels: { 'ys.app': spec.appId } },
        policyTypes: ['Egress'],
        egress: [{
          to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': ns } }, podSelector: { matchLabels: clusterPods } }],
          ports: [{ protocol: 'TCP', port: 5432 }],
        }],
      },
    },
  );
  return objects;
}
