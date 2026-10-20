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
