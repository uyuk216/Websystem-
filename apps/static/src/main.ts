import { serve } from '@hono/node-server';
import { Waker, createStorage, loadStorageConfig } from 'platform';
import { createDb } from 'api/db';
import { createMailer } from 'api/mailer';
import { createTransferMeter } from 'api/transfer';
import { buildRunSpec, createDynamicRuntime } from 'api/dynamic';
import { withWakeLock } from 'api/wake';
import { createStaticApp } from './app.js';

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) throw new Error(`Missing required env var: ${n}`);
  return v;
};

const port = Number(process.env.STATIC_PORT || 8090);
const baseDomain = process.env.BASE_DOMAIN || 'localhost';
const { db, sql } = createDb(need('DATABASE_URL'));
const storage = createStorage(loadStorageConfig(process.env));
const emailKey = Buffer.from(need('EMAIL_ENC_KEY'), 'base64');
const mailer = createMailer(need('SMTP_URL'), process.env.MAIL_FROM || 'no-reply@localhost');
const meter = createTransferMeter({ db, mailer, emailKey });
meter.start();

// Dynamic apps: DYNAMIC_RUNTIME=off disables them (503); otherwise APP_ENV_KEY is required to start apps.
const runtime = createDynamicRuntime(process.env);
const dynamic = runtime && {
  waker: new Waker({
    driver: runtime.driver,
    buildSpec: (appId, deploymentId) => buildRunSpec(db, runtime, appId, deploymentId),
    withLock: (appId, fn) => withWakeLock(db, appId, fn),
    health: runtime.health,
  }),
  proto: process.env.EDGE_PROTO === 'http' ? ('http' as const) : ('https' as const),
};

const app = createStaticApp({ db, storage: storage.sites, meter, baseDomain, dynamic });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`static listening on :${info.port} (*.${baseDomain})`);
});

server.on('upgrade', (req, socket, head) => app.handleUpgrade(req, socket, head));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    void meter.stop().finally(() => {
      storage.close();
      void sql.end();
      process.exit(0);
    });
  });
}
