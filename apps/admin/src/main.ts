import { loadConfig } from '../../api/src/config.js';
import { createDb, assertOwnerBypassesRls } from '../../api/src/db/client.js';
import { createMailer } from '../../api/src/mail/mailer.js';
import { createDynamicRuntime } from '../../api/src/ingest/dynamic.js';
import { listenAdmin } from '../../api/src/admin/listen.js';
import { createPiiPool } from '../../../packages/platform/src/pii/pool.js';
import { createIdBlobStore } from '../../../packages/platform/src/pii/store.js';
import { createAdminShell } from './server.js';

// 127.0.0.1 only: reached through `tailscale serve` (e.g. `tailscale serve --https=443 /admin http://127.0.0.1:3002`
// for the API and `tailscale serve --https=443 / http://127.0.0.1:5175` for this shell).
const config = loadConfig(process.env);
const { db } = createDb(config.databaseUrl);
await assertOwnerBypassesRls(db);
const runtime = createDynamicRuntime(process.env, { db });
const connection = process.env.PII_ADMIN_DATABASE_URL;
const storeSql = connection ? createPiiPool(connection, { max: 2 }) : undefined;
const review = storeSql ? {
  store: createIdBlobStore(storeSql),
  async readCiphertext(uploadId: string, accountId: string): Promise<Uint8Array | null> {
    const [row] = await storeSql`select ciphertext from student_id_blobs where upload_id = ${uploadId} and account_id = ${accountId} and expires_at > now()`;
    return row ? row.ciphertext as Buffer : null;
  },
} : undefined;
listenAdmin({ db, review, driver: runtime?.driver, mailer: createMailer(config.smtpUrl, config.mailFrom), emailEncKey: config.emailEncKey, emailHashKey: config.emailHashKey,
  passkey: { rpId: config.rpId, appOrigin: config.adminOrigin, emailEncKey: config.emailEncKey },
  tailscale: { required: config.tailscaleRequired, devLoopback: config.adminDevTailscale }, secureCookie: config.adminOrigin.startsWith('https:'),
}, config.adminApiPort, config.adminBind);
const port = Number(process.env.ADMIN_UI_PORT ?? 5175);
createAdminShell().listen(port, process.env.ADMIN_UI_HOST ?? '127.0.0.1', () => console.log(`admin ui listening on :${port}`));
