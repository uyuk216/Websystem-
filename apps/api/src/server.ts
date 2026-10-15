import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createApp } from './http/app.js';
import { createMailer } from './mail/mailer.js';

const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
const mailer = createMailer(config.smtpUrl, config.mailFrom);
const app = createApp({ db, mailer, config, trustedProxyHops: config.trustedProxyHops });
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
