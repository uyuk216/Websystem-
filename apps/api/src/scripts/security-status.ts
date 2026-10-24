import { formatStatus, securityStatus } from '../security/status.js';

// サーバーのコンソール専用。何も取得・接続しない。導入済みの部品はまだ無いので、正直に未導入と表示する。
for (const l of formatStatus(securityStatus(process.env))) console.log(l);
