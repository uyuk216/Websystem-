import { PgBoss } from 'pg-boss';

export type { PgBoss };

export const JOBS = {
  processDeployment: 'deployment.process',
  deleteAppStorage: 'app.delete-storage',
  flushTransfer: 'transfer.flush',
} as const;
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
  for (const name of Object.values(JOBS)) await boss.createQueue(name);
  return boss;
}
