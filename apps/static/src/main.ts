import { serve } from '@hono/node-server';
import { Waker, createStorage, loadStorageConfig } from 'platform';
import { createDb } from 'api/db';
import { createMailer } from 'api/mailer';
import { createTransferMeter } from 'api/transfer';
import { buildRunSpec, createDynamicRuntime } from 'api/dynamic';
import { createWakeLocker } from 'api/wake';
import { createAccessLogger } from 'api/logs';
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
const accessLog = createAccessLogger(db);
accessLog.start();

// Dynamic apps: DYNAMIC_RUNTIME=off disables them (503); otherwise APP_ENV_KEY is required to start apps.
const runtime = createDynamicRuntime(process.env);
// Wake locks live on their own small pool, apart from the queries made while an app starts.
const locker = runtime ? createWakeLocker(need('DATABASE_URL'), 8) : undefined;
const dynamic = runtime && {
  waker: new Waker({
    driver: runtime.driver,
    buildSpec: (appId, deploymentId) => buildRunSpec(db, runtime, appId, deploymentId),
    withLock: locker?.lock,
    health: runtime.health,
    maxConcurrentWakes: 8,
  }),
  proto: process.env.EDGE_PROTO === 'http' ? ('http' as const) : ('https' as const),
};

const app = createStaticApp({ db, storage: storage.sites, meter, baseDomain, dynamic, accessLog, trustedProxyHops: Number(process.env.EDGE_TRUSTED_PROXY_HOPS || 0) });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`static listening on :${info.port} (*.${baseDomain})`);
});

server.on('upgrade', (req, socket, head) => app.handleUpgrade(req, socket, head));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Flush access logs only after the server has fully closed so in-flight requests are recorded.
    // Keep-alive sockets and proxied WebSockets would hold close() open forever, so give in-flight requests 10s.
    const closed = new Promise<void>((resolve) => {
      // Idle keep-alive sockets are left to time out (5s) instead of being cut: a proxy reusing one at that moment
      // would fail the request. Anything still open after 10s is closed.
      server.close(() => resolve());
      setTimeout(() => {
        if ('closeAllConnections' in server) server.closeAllConnections();
        resolve();
      }, 10_000).unref();
    });
    void closed.then(() => Promise.all([meter.stop(), accessLog.stop()])).finally(() => {
      void locker?.close();
      storage.close();
      void sql.end();
      process.exit(0);
    });
  });
}
