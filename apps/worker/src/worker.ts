import { deleteAppStorage, processDeployment } from 'api/publish';
import type { Db } from 'api/db';
import { DEPLOY_RETRY_LIMIT, JOBS, type JobName, type PgBoss, type Storage } from 'platform';

export type JobHandler = (data: unknown, ctx?: { lastAttempt: boolean }) => Promise<void>;
export type Handlers = Record<JobName, JobHandler>;

/** Job handlers. `flushTransfer` is still a placeholder (Task 5). */
export function defaultHandlers(deps?: { db: Db; storage: Storage }): Handlers {
  const todo = (name: string): JobHandler => async () => {
    console.warn(`worker: no handler implemented for ${name}`);
  };
  return {
    [JOBS.processDeployment]: deps ? makeProcessDeployment(deps) : todo(JOBS.processDeployment),
    [JOBS.deleteAppStorage]: deps ? makeDeleteAppStorage(deps) : todo(JOBS.deleteAppStorage),
    [JOBS.flushTransfer]: todo(JOBS.flushTransfer),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (data: unknown, name: string): string | null => {
  const v = (data as Record<string, unknown> | null)?.[name];
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
};
const makeProcessDeployment = (d: { db: Db; storage: Storage }): JobHandler => async (data, ctx) => {
  const id = field(data, 'deploymentId');
  if (id) await processDeployment(d.db, d.storage, id, { lastAttempt: ctx?.lastAttempt ?? false });
};
const makeDeleteAppStorage = (d: { storage: Storage }): JobHandler => async (data) => {
  const id = field(data, 'appId');
  if (id) await deleteAppStorage(d.storage, id);
};

/** Registers one handler per job name. The boss must already be started with queues created. */
export async function registerHandlers(boss: PgBoss, handlers: Handlers): Promise<void> {
  for (const name of Object.values(JOBS)) {
    await boss.work(name, async (jobs) => {
      for (const job of jobs) await handlers[name](job.data, { lastAttempt: name !== JOBS.processDeployment || job.retryCount >= DEPLOY_RETRY_LIMIT });
    });
  }
}
