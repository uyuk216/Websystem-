import { serve } from '@hono/node-server';
import { createQueue, createStorage, loadStorageConfig, startQueue } from 'platform';
import { loadConfig } from './config.js';
import { assertOwnerBypassesRls, createDb } from './db/client.js';
import { createApp } from './http/app.js';
import { createGithubClient } from './github/client.js';
import { createDynamicRuntime } from './ingest/dynamic.js';
import { handleTunnelUpgrade } from './apps/database-tunnel.js';
import { createWakeLocker } from './apps/wake.js';
import { createMailer } from './mail/mailer.js';
import { createGithubAccountLookup } from './verification/github-age.js';
import { createAdminApp } from './admin/server.js';

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
await assertOwnerBypassesRls(db);
const mailer = createMailer(config.smtpUrl, config.mailFrom);
const storage = createStorage(loadStorageConfig(process.env));
await storage.ensureBuckets();
const queue = await startQueue(createQueue(config.databaseUrl));
const runtime = createDynamicRuntime(process.env, { db });
// Rollbacks start containers under the same per-app wake lock as the worker and the edge (own small pool).
if (runtime) runtime.lock = createWakeLocker(config.databaseUrl, 4).lock;
const app = createApp({ db, runtime, mailer, config, trustedProxyHops: config.trustedProxyHops, storage, queue, uploadMaxBytes: config.uploadMaxBytes,
  // SMS 認証のプロバイダーはフェーズ 8。それまで `sms` は渡さない（SMS のルートは 503）。
  starter: { githubAge: createGithubAccountLookup() },
  github: config.github && { webhookSecret: config.github.webhookSecret, client: createGithubClient(config.github) },
});
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
// `yourservice db connect`: raw PostgreSQL over an upgraded connection (see apps/database-tunnel.ts).
server.on('upgrade', (req, socket, head) => {
  if (!handleTunnelUpgrade(db, runtime, req, socket, head)) socket.destroy();
});
// Admin API: a separate app on a separate port, never mounted on the public app. Reachable only from Tailscale (see admin/tailscale.ts).
const adminApp = createAdminApp({
  db, mailer, emailEncKey: config.emailEncKey,
  passkey: { rpId: config.rpId, appOrigin: config.adminOrigin, emailEncKey: config.emailEncKey },
  tailscale: { required: config.tailscaleRequired, devLoopback: config.adminDevTailscale },
  secureCookie: config.adminOrigin.startsWith('https:'),
});
serve({ fetch: adminApp.fetch, port: config.adminApiPort, hostname: config.adminBind }, (info) => {
  console.log(`admin api listening on ${config.adminBind}:${info.port}`);
});
