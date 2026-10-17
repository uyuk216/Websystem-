import { assertUuid, type AppRunSpec } from './driver.js';

export const METADATA_IP_CIDR = '169.254.169.254/32';

export function namespaceFor(ownerId: string): string {
  assertUuid(ownerId, 'ownerId');
  return `ys-o-${ownerId.replace(/-/g, '').toLowerCase()}`;
}

export function workloadName(appId: string, deploymentId: string): string {
  assertUuid(appId, 'appId');
  assertUuid(deploymentId, 'deploymentId');
  return `ys-app-${appId}-${deploymentId.slice(0, 8)}`;
}

/** Pure manifest builder; applied by KubernetesDriver. */
export interface ManifestOptions {
  /** RuntimeClass for app pods. Null omits it (development clusters without gVisor only). */
  runtimeClassName?: string | null;
}

export function buildKubernetesManifests(spec: AppRunSpec, opts: ManifestOptions = {}): object[] {
  const runtimeClassName = opts.runtimeClassName === undefined ? 'gvisor' : opts.runtimeClassName;
  const ns = namespaceFor(spec.ownerId);
  const name = workloadName(spec.appId, spec.deploymentId);
  // One Deployment/Service per deployment so a new version can pass its health check before the switch.
  const labels = { 'ys.app': spec.appId, 'ys.deployment': spec.deploymentId };
  const mem = `${spec.limits.memoryMb}Mi`;
  const cpu = String(spec.limits.cpu);
  const env = Object.entries({ ...spec.env, PORT: String(spec.port) }).map(([k, v]) => ({ name: k, value: v }));

  return [
    { apiVersion: 'v1', kind: 'Namespace', metadata: {
        name: ns,
        labels: {
          'ys.owner': ns,
          'pod-security.kubernetes.io/enforce': 'restricted',
          'pod-security.kubernetes.io/enforce-version': 'latest',
        },
      },
    },
    {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            ...(runtimeClassName ? { runtimeClassName } : {}),
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, runAsUser: 65534, runAsGroup: 65534, seccompProfile: { type: 'RuntimeDefault' } },
            containers: [
              {
                name: 'app',
                image: spec.image,
                imagePullPolicy: 'IfNotPresent',
                env,
                ports: [{ containerPort: spec.port }],
                securityContext: {
                  runAsNonRoot: true,
                  privileged: false,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                resources: {
                  requests: { memory: mem, cpu },
                  limits: { memory: mem, cpu, 'ephemeral-storage': '128Mi' },
                },
                volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
              },
            ],
            volumes: [{ name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '64Mi' } }],
          },
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name, namespace: ns, labels },
      spec: { selector: labels, ports: [{ port: spec.port, targetPort: spec.port }] },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'ys-app-isolation', namespace: ns },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress', 'Egress'],
        // Only the edge may reach apps; other namespaces and other owners are denied.
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'ys-system' } } }],
            ports: [{ protocol: 'TCP', port: spec.port }],
          },
        ],
        egress: [
          // DNS only via kube-system.
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
            ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }],
          },
          // Public internet only: no cluster/private ranges (other namespaces, platform), no metadata, no SMTP.
          {
            to: [
              {
                ipBlock: {
                  cidr: '0.0.0.0/0',
                  except: [METADATA_IP_CIDR, '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10'],
                },
              },
            ],
            ports: [
              { protocol: 'TCP', port: 80 },
              { protocol: 'TCP', port: 443 },
              { protocol: 'TCP', port: 5432 },
              { protocol: 'TCP', port: 3306 },
            ],
          },
        ],
      },
    },
    {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'ys-owner-quota', namespace: ns },
      spec: {
        hard: {
          pods: '2',
          'requests.memory': `${spec.limits.memoryMb * 2}Mi`,
          'limits.memory': `${spec.limits.memoryMb * 2}Mi`,
          'requests.cpu': String(spec.limits.cpu * 2),
          'limits.cpu': String(spec.limits.cpu * 2),
          'requests.ephemeral-storage': '256Mi',
          'limits.ephemeral-storage': '256Mi',
        },
      },
    },
    {
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: { name: 'ys-owner-limits', namespace: ns },
      spec: {
        limits: [
          {
            type: 'Container',
            default: { memory: mem, cpu, 'ephemeral-storage': '128Mi' },
            defaultRequest: { memory: mem, cpu, 'ephemeral-storage': '128Mi' },
            max: { memory: mem, cpu, 'ephemeral-storage': '128Mi' },
          },
        ],
      },
    },
  ];
}
