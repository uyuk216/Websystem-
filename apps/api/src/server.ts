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
import { loadSecurityKey } from './security/config.js';

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
  security: { hashKey: loadSecurityKey(process.env) },
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
