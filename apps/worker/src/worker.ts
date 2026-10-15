import { JOBS, type JobName, type PgBoss } from 'platform';

export type JobHandler = (data: unknown) => Promise<void>;
export type Handlers = Record<JobName, JobHandler>;

/** Placeholder handlers; Tasks 3-4 fill these in. */
export function defaultHandlers(): Handlers {
  const todo = (name: string): JobHandler => async () => {
    console.warn(`worker: no handler implemented for ${name}`);
  };
  return {
    [JOBS.processDeployment]: todo(JOBS.processDeployment),
    [JOBS.deleteAppStorage]: todo(JOBS.deleteAppStorage),
    [JOBS.flushTransfer]: todo(JOBS.flushTransfer),
  };
}

/** Registers one handler per job name. The boss must already be started with queues created. */
export async function registerHandlers(boss: PgBoss, handlers: Handlers): Promise<void> {
  for (const name of Object.values(JOBS)) {
    await boss.work(name, async (jobs) => {
      for (const job of jobs) await handlers[name](job.data);
    });
  }
}
