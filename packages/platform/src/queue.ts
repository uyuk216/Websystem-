import { PgBoss } from 'pg-boss';

export type { PgBoss };

export const JOBS = {
  processDeployment: 'deployment.process',
  deleteAppStorage: 'app.delete-storage',
  /** 毎時: 学生証の暗号文の期限切れ・孤児の掃除（Task 4）。 */
  verificationPurge: 'verification.purge',
  /** 毎時: 利用の状態の評価（付与の期限・停止日、3 月の再登録の案内）（Task 7）。 */
  dangerousExecute: 'admin.dangerous-execute',
  usageEvaluate: 'usage.evaluate',
} as const;
/** Retries for deployment processing (pg-boss retryLimit); the last attempt records the failure. */
export const DEPLOY_RETRY_LIMIT = 3;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

/**
 * pg-boss keeps its tables in the dedicated `pgboss` schema. `databaseUrl` must be the owner
 * connection: the platform_api role has no grants there, so queue access happens only from
 * API process code / the worker, never inside withAccount.
 */
export function createQueue(databaseUrl: string): PgBoss {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => console.error('pg-boss error', err));
  return boss;
}

/** Starts the queue and creates all known job queues (idempotent). */
export async function startQueue(boss: PgBoss): Promise<PgBoss> {
  await boss.start();
  for (const name of Object.values(JOBS)) {
    const options = name === JOBS.processDeployment ? { retryLimit: DEPLOY_RETRY_LIMIT, retryDelay: 5, retryBackoff: true } : {};
    await boss.createQueue(name, options);
    // createQueue is a no-op for an existing queue, so apply the current options explicitly.
    if (Object.keys(options).length > 0) await boss.updateQueue(name, options);
  }
  return boss;
}
