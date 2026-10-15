import { serve } from '@hono/node-server';
import { createStorage, loadStorageConfig } from 'platform';
import { createDb } from 'api/db';
import { createMailer } from 'api/mailer';
import { createTransferMeter } from 'api/transfer';
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

const app = createStaticApp({ db, storage: storage.sites, meter, baseDomain });
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`static listening on :${info.port} (*.${baseDomain})`);
});

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
