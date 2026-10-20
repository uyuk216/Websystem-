import { deleteAppStorage, processDeployment } from 'api/publish';
import type { DynamicRuntime } from 'api/dynamic';
import type { Db } from 'api/db';
import { purgeVerifications } from 'api/verification-purge';
import type { IdBlobStore } from 'api/verification-purge';
import { evaluateDueOwners, sendReregistrationNotices } from 'api/usage-state';
import type { Mailer } from 'api/mailer';
import { DEPLOY_RETRY_LIMIT, JOBS, type JobName, type PgBoss, type Storage } from 'platform';

export type JobHandler = (data: unknown, ctx?: { lastAttempt: boolean }) => Promise<void>;
export type Handlers = Record<JobName, JobHandler>;

/** Job handlers. (Transfer counters are flushed by the static server itself, not by a job.) */
export interface WorkerDeps {
  db: Db;
  storage: Storage;
  runtime?: DynamicRuntime;
  /** 学生証の暗号文を消す口。個人情報 DB の接続がないときは渡さない（掃除はスキップ）。 */
  verification?: { store: IdBlobStore; mailer?: Mailer; emailKey?: Buffer };
  /** 利用の状態の評価で、コンテナを止め（driver）、通知を送る（mailer + emailKey）口。いずれも無くても評価はできる。 */
  usage?: { mailer?: Mailer; emailKey?: Buffer };
  /** テスト用の時計。 */
  now?: () => Date;
}

export function defaultHandlers(deps?: WorkerDeps): Handlers {
  const todo = (name: string): JobHandler => async () => {
    console.warn(`worker: no handler implemented for ${name}`);
  };
  return {
    [JOBS.processDeployment]: deps ? makeProcessDeployment(deps) : todo(JOBS.processDeployment),
    [JOBS.deleteAppStorage]: deps ? makeDeleteAppStorage(deps) : todo(JOBS.deleteAppStorage),
    [JOBS.usageEvaluate]: deps ? makeUsageEvaluate(deps) : todo(JOBS.usageEvaluate),
    [JOBS.verificationPurge]: deps?.verification ? makeVerificationPurge({ db: deps.db, ...deps.verification }) : todo(JOBS.verificationPurge),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (data: unknown, name: string): string | null => {
  const v = (data as Record<string, unknown> | null)?.[name];
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
};
const makeProcessDeployment = (d: { db: Db; storage: Storage; runtime?: DynamicRuntime }): JobHandler => async (data, ctx) => {
  const id = field(data, 'deploymentId');
  if (id) await processDeployment(d.db, d.storage, id, { lastAttempt: ctx?.lastAttempt ?? false, runtime: d.runtime });
};
const makeDeleteAppStorage = (d: { storage: Storage; runtime?: DynamicRuntime }): JobHandler => async (data) => {
  const id = field(data, 'appId');
  if (id) await deleteAppStorage(d.storage, id, d.runtime);
};

/** 付与の期限・停止日が来たオーナーを評価し（状態の遷移は `transitionUsageState` の 1 か所）、3 月は再登録の案内を送る。 */
const makeUsageEvaluate = (d: WorkerDeps): JobHandler => async () => {
  const now = d.now?.() ?? new Date();
  const n = await evaluateDueOwners(d.db, { now, driver: d.runtime?.driver, mailer: d.usage?.mailer, emailKey: d.usage?.emailKey });
  const sent = d.usage?.mailer && d.usage.emailKey ? await sendReregistrationNotices(d.db, { now, mailer: d.usage.mailer, emailKey: d.usage.emailKey }) : 0;
  if (n + sent > 0) console.log(`worker: usage evaluate owners=${n} reregistrationNotices=${sent}`);
};

const makeVerificationPurge = (d: { db: Db; store: IdBlobStore; mailer?: Mailer; emailKey?: Buffer }): JobHandler => async () => {
  const r = await purgeVerifications(d.db, d);
  if (r.expired + r.blobsDeleted + r.staleUploads > 0) console.log(`worker: verification purge expired=${r.expired} blobsDeleted=${r.blobsDeleted} staleUploads=${r.staleUploads}`);
};

/** Registers one handler per job name. The boss must already be started with queues created. */
export async function registerHandlers(boss: PgBoss, handlers: Handlers): Promise<void> {
  for (const name of Object.values(JOBS)) {
    await boss.work(name, async (jobs) => {
      for (const job of jobs) await handlers[name](job.data, { lastAttempt: name !== JOBS.processDeployment || job.retryCount >= DEPLOY_RETRY_LIMIT });
    });
  }
}
