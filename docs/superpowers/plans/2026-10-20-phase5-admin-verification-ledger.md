# SDD ledger — plan: docs/superpowers/plans/2026-10-20-phase5-admin-verification.md
## Progress

### Task 1: 個人情報 DB（分離） — 実装済み（未コミット）
- 追加: `dev/compose.yaml` に `pii-db`（コンテナ `ys-pii-db`、ネットワーク `ys-piinet` のみ、`127.0.0.1:54321`）、`dev/pii-init/01-roles.sh`（ロール `pii_admin` / `pii_ingest`、開発用ダミーパスワード）、`apps/api/drizzle-pii/0000_init.sql`（`student_id_blobs`・`verification_reviews`、外部キーなし。`pii_ingest` は INSERT のみ、`pii_admin` は blobs の SELECT/DELETE と reviews の SELECT/INSERT）。
- `packages/platform/src/pii/{pool,schema,migrate}.ts`（`createPiiPool`、`applyPiiMigrations`、`pii:migrate`）。`postgres` を dependencies へ移動、`tsx` を devDependencies に追加。
- 接続情報は `.env.pii.development(.example)` に分離（`.env.development` と `apps/api` には出さない）。`scripts/dev-up.sh` が作成・migrate。`.gitignore` に example を例外追加。
- テスト: `apps/api/test/pii-isolation.test.ts`（api 配下・env・scripts・loadConfig に PII 設定なし）、`packages/platform/test/pii/{pii-db,network}.test.ts`（ロール権限、ネットワーク）。
- 注意: ホストに公開したポートは Docker の公開ポート規則により、別ブリッジのコンテナからコンテナ IP 直指定で届く（名前解決は不可）。テストは名前解決の不可と `ys-piinet` 単独接続・ループバック公開までを固定。IP 直指定の遮断は本番のホスト／ネットワーク分離（フェーズ 8）で担保する。

### Task 2: ブラウザ内暗号化ライブラリ — 実装済み（未コミット）
- 追加: `packages/shared/src/idcrypt/{envelope,hybrid-kem,encrypt,decrypt,keys,index}.ts`、`packages/shared/test/idcrypt.test.ts`。`shared` の index から再エクスポート。
- 方式: X25519（WebCrypto）+ ML-KEM-768（`@noble/post-quantum`）→ HKDF-SHA256 → AES-256-GCM。AAD に版・`uploadId`・`accountId` を束縛。鍵は 公開 = x25519(32)+mlkem(1184)、秘密 = seed(32)+mlkem(2400)。
- `sanitizeIdImage`（ブラウザ専用、OffscreenCanvas で再描画し EXIF を落とし 3MB 以下の JPEG に）。`Decryptor` / `LocalKeyDecryptor` / `ExternalCommandDecryptor`（薄い実装、実機確認は運営者）。
- 未実施: Playwright でのブラウザ⇔Node 相互復号と平文送信なしの確認（Playwright 未導入・パッケージ追加不可のため。Task 3 の `apps/upload` E2E と一緒に実施）。

### Task 3: 取り込み口と `apps/upload` — 実装済み（未コミット）
- 本体 DB: `0025_student_verifications.sql`（`student_verifications`・`verification_uploads`、RLS：本人だけ読める／pending の間だけ作成・更新、承認系の列と提出トークンの消費はシステム側だけ）。画像・暗号文の列はなし。提出トークンは `<uploadId>.<accountId>.<秘密>`（10 分・1 回限り、DB にはハッシュのみ）。
- API: `POST /verification/start`（Cookie セッション必須、`NetworkReputation` で VPN/Tor は 403、1 時間 10 回）、取り込み口専用の `POST /internal/verification/consume-token`（`INGEST_SHARED_SECRET` が設定されたときだけ存在、ヘッダー不一致は 404）。`shared` に `verification.ts`・`network-reputation.ts`（固定実装つき）、i18n に日英の文言。
- 取り込み口: ロジックは `platform/pii/ingest.ts`（`handleIdUpload`）。`pii_ingest` で追記のみ、ID はトークン由来だけ、ログはイベント・状態・サイズだけ。**`apps/api` には PII の文字列を一切置かない**（`pii-isolation` テストが通る）。
- `apps/upload`: **Next.js ではなく素の Node サーバー + esbuild の 1 本のバンドル**にした（計画からの変更）。Next の起動用インラインスクリプトは内容が毎回変わりハッシュ固定にできず、`script-src` を SRI のハッシュだけにできないため。CSP は `default-src 'none'`・`script-src` はバンドルの sha384 のみ・`frame-ancestors 'none'`、サードパーティなし（`src/security-headers.ts` が計画の `middleware.ts` に相当）。トークンはアドレスバーから即消す。
- 検証: Playwright（`pnpm --filter upload e2e`、実 Chromium）で、送信は封筒の POST 1 回のみ・同一オリジン・平文の断片なし・Node で復号できることを確認（**Task 2 で未実施だったブラウザ⇔Node の相互復号もここで完了**）。CSP 違反の警告もなし。
- 配線メモ: `apps/upload` の `node_modules` は pnpm install をせず、既存パッケージへのリンクを手で作成し `pnpm-lock.yaml` に importer を追記（`--frozen-lockfile` 検証済み、新規パッケージなし）。クリーン環境では `pnpm install` で同じ状態になる。`.env.development(.example)` に `UPLOAD_ORIGIN`・`INGEST_SHARED_SECRET`（開発用ダミー）を追加。`ID_RECIPIENT_PUBLIC_KEY` は `pnpm --filter upload keygen` で作る。
- 未実施・持ち越し: 実際の API ⇔ 取り込み口 ⇔ 個人情報 DB を通した結合は未確認（各部分は個別テスト済み）。トークン消費後に PII への書き込みが失敗した場合は再度「提出を始める」必要があり、残った `verification_uploads` は Task 4 の `purge` で掃除する。7 日での `expired` 化・暗号文削除・再提出メールは Task 4。ルートの `dev` スクリプトには `upload` を追加していない。
