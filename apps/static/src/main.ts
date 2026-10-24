import { createDistributionObserver } from 'api/security-distribution';
import { serve } from '@hono/node-server';
import { Waker, createStorage, loadStorageConfig } from 'platform';
import { createDb } from 'api/db';
import { createMailer } from 'api/mailer';
import { createTransferMeter } from 'api/transfer';
import { buildRunSpec, createDynamicRuntime } from 'api/dynamic';
import { createWakeLocker } from 'api/wake';
import { createAccessLogger } from 'api/logs';
import { loadSecurityKey } from 'api/security-config';
import { createSecurityGateApp } from 'api/security-gate-server';
import { isAppBlocked } from 'api/security-gate';
import { createStaticApp } from './app.js';
import { ConnectionRegistry } from './connections.js';
import { resolveSite } from './site.js';

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
const runtime = createDynamicRuntime(process.env, { db });
// Wake locks live on their own small pool, apart from the queries made while an app starts.
const locker = runtime ? createWakeLocker(need('DATABASE_URL'), 8) : undefined;
const dynamic = runtime && {
  waker: new Waker({
    driver: runtime.driver,
    buildSpec: (appId, deploymentId) => buildRunSpec(db, runtime, appId, deploymentId),
    withLock: locker?.lock,
    health: runtime.health,
    maxConcurrentWakes: 8,
    // 遮断中のアプリは、起動のロックの中でも起動しない。
    allowStart: async (appId: string) => !(await isAppBlocked(db, appId)),
  }),
  proto: process.env.EDGE_PROTO === 'http' ? ('http' as const) : ('https' as const),
};

const trustedProxyHops = Number(process.env.EDGE_TRUSTED_PROXY_HOPS || 0);
const securityKey = loadSecurityKey(process.env);
const connections = new ConnectionRegistry();
const stopRecheck = connections.start(db, 1000);
// 遮断の commit 通知が来たら、すぐ再照合する（通知が欠けても、上の定期の再照合が拾う）。
const listener = await sql.listen('security_block', () => { void connections.recheck(db); }).catch((e: unknown) => { console.error('security listen failed', e); return null; });

const app = createStaticApp({ db, storage: storage.sites, meter, baseDomain, dynamic, accessLog, trustedProxyHops, distribution: process.env.SECURITY_DISTRIBUTION_MODE === 'enforce' ? createDistributionObserver(db, securityKey) : undefined, reportOrigin: process.env.APP_ORIGIN ?? 'http://localhost:3000', security: { hashKey: securityKey, connections } });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`static listening on :${info.port} (*.${baseDomain})`);
});

// Traefik の ForwardAuth が呼ぶ内部の判定口。localhost / 内部ネットワークの接続元だけを受ける。
const gateApp = createSecurityGateApp({ db, hashKey: securityKey, trustedProxyHops, siteName: (host) => resolveSite(host, baseDomain) });
const gateServer = serve({ fetch: gateApp.fetch, port: Number(process.env.SECURITY_GATE_PORT || 8091), hostname: process.env.SECURITY_GATE_BIND || '127.0.0.1' }, (info) => {
  console.log(`security gate listening on :${info.port}`);
});

server.on('upgrade', (req, socket, head) => app.handleUpgrade(req, socket, head));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Flush access logs only after the server has fully closed so in-flight requests are recorded.
    // Keep-alive sockets and proxied WebSockets would hold close() open forever, so give in-flight requests 10s.
    const closed = new Promise<void>((resolve) => {
      // Idle keep-alive sockets are left to time out (5s) instead of being cut: a proxy reusing one at that moment
      // would fail the request. Anything still open after 10s is closed.
      stopRecheck();
      void listener?.unlisten();
      gateServer.close();
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
