import { serve } from '@hono/node-server';
import { createQueue, createStorage, loadStorageConfig, startQueue } from 'platform';
import { loadConfig } from './config.js';
import { assertOwnerBypassesRls, createDb } from './db/client.js';
import { createApp } from './http/app.js';
import { createGithubClient } from './github/client.js';
import { createDynamicRuntime } from './ingest/dynamic.js';
import { createMailer } from './mail/mailer.js';

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
await assertOwnerBypassesRls(db);
const mailer = createMailer(config.smtpUrl, config.mailFrom);
const storage = createStorage(loadStorageConfig(process.env));
await storage.ensureBuckets();
const queue = await startQueue(createQueue(config.databaseUrl));
const runtime = createDynamicRuntime(process.env);
const app = createApp({ db, runtime, mailer, config, trustedProxyHops: config.trustedProxyHops, storage, queue, uploadMaxBytes: config.uploadMaxBytes,
  github: config.github && { webhookSecret: config.github.webhookSecret, client: createGithubClient(config.github) },
});
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
