/** E2E 用：本物の提出ページとスクリプトを配り、取り込み口だけを空の実装にする（ネットワークの中身はテスト側が見る）。 */
import { buildClientAssets } from '../src/client-build.js';
import { createUploadServer } from '../src/server.js';

const server = createUploadServer({
  assets: await buildClientAssets(),
  recipientPublicKeyB64: process.env.E2E_PUBLIC_KEY!,
  ingest: async () => ({ status: 204 }),
});
server.listen(5175, '127.0.0.1');
