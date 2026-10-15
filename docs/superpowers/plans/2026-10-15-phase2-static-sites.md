# フェーズ 2（静的サイト）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web（ZIP）・CLI・GitHub の 3 つの入口から静的サイトを公開し、開発環境では `http://<アプリ名>.localhost:8090` で見られるようにする。転送量・容量の制限、`.env` などのブロック、秘密情報チェック、実行ファイルの保留、ロールバックまで含める。

**Architecture:** API が「アプリ」と「デプロイ」を管理し、受け取ったソースを MinIO に保存してジョブキュー（pg-boss）に積む。`apps/worker` がジョブを取り出して検査・展開し、公開用ファイルを MinIO に置いてから、アプリの「公開中デプロイ」を切り替える。`apps/static` は Host ヘッダからアプリを引き、MinIO のファイルを返しながら転送量を数える。CLI は API トークンで認証する。

**Tech Stack:** 既存（Hono、Drizzle、vitest、Next.js、Playwright）に加えて pg-boss、@aws-sdk/client-s3（MinIO）、yauzl（ZIP）、tar、ignore（.gitignore 解釈）、commander（CLI）、@octokit/rest と @octokit/webhooks-methods（GitHub）。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（主に 3 章、5.2、5.4、9.4 のうち静的サイトに関わる部分）

## Global Constraints

- 静的サイトの初期値：**容量 200MB、1 ファイル最大 25MB、転送量 月 10GB**。数値は `packages/shared/src/plans.ts` の 1 か所に置く。
- **プランと審査はフェーズ 5**。フェーズ 2 では「持ち主（個人またはチーム）ごとに静的サイト 1 つ」を上限とし、無料枠の判定（Student かどうか）は行わない。
- アプリ名：`^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$`（3〜32 文字、英小文字・数字・ハイフン、先頭末尾はハイフン不可、`--` 不可）。予約語リストは `packages/shared/src/reserved-names.ts`（`www`、`admin`、`api`、`login`、`app`、`static`、`mail`、`status`、`docs`、`help`、`support`、`security`、`paypal`、`google`、`apple`、`microsoft`、`github`、`amazon`、`line`、`stripe` など 50 語以上）。
- アップロード時に**常に除外**：`.env`、`.env.*`、`.git/`、`.DS_Store`、`node_modules/`。配信時に**常に 404**：パスのどこかに `.` で始まる要素を含むもの（`/.well-known/` だけは許可）。
- 秘密情報チェック：鍵らしい文字列が見つかったらデプロイを `blocked_secret` にして公開しない（どのファイルの何行目かを表示、値は表示しない）。
- 実行ファイル（`.exe` `.apk` `.dmg` `.msi` `.app` `.deb` `.rpm` `.bat` `.sh` `.jar`）を含むデプロイは `held_for_review` にして公開しない（解除はフェーズ 5 の管理画面）。
- ZIP / tar の展開では、パストラバーサル（`../`、絶対パス、シンボリックリンク）を拒否する。
- 転送量の上限に達したサイトは、月末まで **HTTP 503** と「今月の転送量の上限に達しました」ページ（日英）を返す。80% で持ち主に通知する。
- 静的サイトはフェーズ 2 では**ビルドしない**（アップロードされたファイルをそのまま公開）。公開するフォルダはアプリ設定 `publishDir`（既定 `/`、例 `dist`）で選ぶ。ビルドはフェーズ 3 の BuildKit で扱う。
- 開発環境の URL は `http://<アプリ名>.localhost:8090`（Chrome / Firefox）。ドキュメントに https は mkcert で可能と書く。
- 認証が必要な処理はすべて `withAccount`、認証前・ワーカーの処理は `withSystem` を使う。新しいテーブルには RLS を付ける。
- 文言はすべて `packages/i18n`（日英）。

## Review Focus

1. **ZIP スリップ・シンボリックリンク・巨大展開（zip bomb）** → 拒否し、展開後の合計サイズが 200MB を超えた時点で中断する。Task 3 のテストで固定。
2. **大文字のホスト名・ポート付き Host・未知のアプリ名・公開中デプロイがないアプリ** → 小文字化して判定、ポートを無視、未知・未公開は 404。Task 5 のテストで固定。
3. **同じアプリへの同時デプロイ** → 後から完了したほうが勝つのではなく、**後から作成された**デプロイが公開される（古いものが遅れて完了しても上書きしない）。Task 4 のテストで固定。
4. **`/foo/` と `/foo` と `/foo/index.html`、日本語ファイル名（URL エンコード）、`..` を含むパス** → ディレクトリは index.html、エンコードは正しく解釈、`..` は 400。Task 5 のテストで固定。
5. **GitHub Webhook の署名なし・署名違い・関係ないブランチ・削除された push** → 署名不正は 401、それ以外は無視（200）。Task 6 のテストで固定。

---

## ファイル構成

```
packages/shared/src/plans.ts            静的サイトの上限値
packages/shared/src/app-name.ts          validateAppName
packages/shared/src/reserved-names.ts
apps/api/src/apps/apps.ts                アプリの作成・一覧・削除・設定
apps/api/src/apps/deployments.ts         デプロイの作成・一覧・ロールバック・公開切り替え
apps/api/src/apps/api-tokens.ts          CLI 用トークン
apps/api/src/storage/s3.ts               MinIO クライアント
apps/api/src/jobs/queue.ts               pg-boss の起動とジョブ名
apps/api/src/ingest/archive.ts           ZIP / tar の安全な展開と除外
apps/api/src/ingest/secret-scan.ts       秘密情報チェック
apps/api/src/ingest/publish.ts           公開用ファイルの配置
apps/api/src/github/webhook.ts           署名検証とイベント処理
apps/api/src/github/client.ts            インストールトークンとソース取得
apps/api/src/usage/transfer.ts           転送量の集計と上限判定
apps/worker/src/index.ts                 ジョブの処理
apps/static/src/server.ts                静的サイト配信
apps/cli/src/index.ts                    yourservice コマンド
apps/web/app/[locale]/(app)/apps/...     アプリ画面
```

---

### Task 1: アプリのデータ構造と名前のルール

**Files:** `packages/shared/src/{plans,app-name,reserved-names}.ts`、`apps/api/src/apps/apps.ts`、スキーマとマイグレーション、`apps/api/src/http/app.ts`、テスト

**Interfaces:**
- Produces:
  - `STATIC_LIMITS = { storageBytes: 200 * 1024 ** 2, fileBytes: 25 * 1024 ** 2, monthlyTransferBytes: 10 * 1024 ** 3, sitesPerOwner: 1 }`
  - `validateAppName(name: string): { ok: true } | { ok: false; reason: 'format' | 'reserved' }`
  - テーブル `apps(id, ownerId → owners.id, name unique, kind 'static', publishDir text default '', activeDeploymentId null, githubRepo null, githubBranch null, githubInstallationId null, createdAt)`、`deployments(id, appId, source 'upload'|'cli'|'github', status 'queued'|'processing'|'live'|'superseded'|'failed'|'blocked_secret'|'held_for_review', sourceKey text, siteKey text null, totalBytes bigint null, fileCount int null, message text null, findings jsonb null, commitSha null, createdBy accountId null, createdAt, finishedAt null)`
  - `createApp(db, accountId, input: { name; ownerId; publishDir? })` → `{ appId } | { error: 'format' | 'reserved' | 'taken' | 'forbidden' | 'limit' }`（チームの持ち主なら `deploy` 権限が必要）
  - `listApps(db, accountId)`、`getApp(db, accountId, appId)`、`updateApp(db, accountId, appId, { publishDir })`、`deleteApp(db, accountId, appId)`（ストレージ削除はジョブに積む）
  - RLS：アプリは「持ち主が自分」または「持ち主のチームのメンバー」だけ見える。`app_can_access_owner(owner uuid)` を SECURITY DEFINER で作る
  - HTTP：`GET/POST /apps`、`GET/PATCH/DELETE /apps/:id`

- [ ] テストを先に書く：名前の形式（`ab` ✗、`a-b` ✓、`-ab` ✗、`a--b` ✗、`ABC` ✗、33 文字 ✗）、予約語、同名の重複、持ち主ごとに 1 つ（2 つ目は `limit`）、チームの `member` は作れる（deploy 権限）、他人のアプリは見えない
- [ ] 失敗を確認 → 実装 → 成功を確認 → Commit `feat: add apps with name rules`

### Task 2: ストレージとジョブキュー

**Files:** `apps/api/src/storage/s3.ts`、`apps/api/src/jobs/queue.ts`、`apps/worker/`（新パッケージ、`pnpm --filter worker dev`）、`dev/compose.yaml`（MinIO のバケット作成）、`.env.development.example`、テスト

**Interfaces:**
- Produces:
  - `createStorage(cfg) → { put(key, body, contentType?), get(key) → stream + size + contentType | null, head(key), list(prefix), deletePrefix(prefix) }`（バケット：`sources`、`sites`）
  - `createQueue(databaseUrl) → PgBoss` とジョブ名 `JOBS = { processDeployment: 'deployment.process', deleteAppStorage: 'app.delete-storage', flushTransfer: 'transfer.flush' }`
  - worker のエントリ：ジョブ名ごとのハンドラを登録して待機する。ハンドラは Task 3〜4 で中身を入れる
  - 環境変数：`S3_ENDPOINT`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_REGION`（開発用の値を example に）
- [ ] テスト：MinIO への put / get / deletePrefix の往復、ジョブを積むとハンドラが呼ばれる
- [ ] Commit `feat: add object storage and job queue`

### Task 3: 安全な展開・除外・秘密情報チェック・実行ファイル検出

**Files:** `apps/api/src/ingest/{archive,secret-scan}.ts`、テスト（ZIP・tar のフィクスチャはテスト内で生成）

**Interfaces:**
- Produces:
  - `extractArchive(input: Readable, format: 'zip' | 'tar.gz', limits): AsyncIterable<{ path: string; size: number; open(): Readable }>` を返す前段として、`inspectArchive(...)` → `{ files: FileEntry[]; excluded: string[]; totalBytes } | { error: 'too_large' | 'file_too_large' | 'unsafe_path' | 'symlink' | 'corrupt' }`。除外ルールは Global Constraints のとおり
  - `scanSecrets(path: string, content: Buffer): Finding[]`（`{ path, line, rule }`。ルール：AWS アクセスキー `AKIA[0-9A-Z]{16}`、GitHub トークン `gh[pousr]_[A-Za-z0-9]{36,}`、Stripe `sk_(live|test)_[A-Za-z0-9]{16,}`、Slack `xox[baprs]-`、秘密鍵 `-----BEGIN [A-Z ]*PRIVATE KEY-----`、Google API キー `AIza[0-9A-Za-z_-]{35}`、`.env` 形式の `(SECRET|TOKEN|PASSWORD|API_KEY)\s*=\s*\S{8,}`。テキストファイル（2MB 以下、NUL を含まない）だけ調べる）
  - `findExecutables(paths: string[]): string[]`
- [ ] テスト：`../evil`、`/etc/passwd`、シンボリックリンク、合計 200MB 超（実データを作らず宣言サイズで判定し、実際の展開でも上限で止まることを確認）、26MB の 1 ファイル、`.env` と `.git/` と `node_modules/` の除外、各秘密ルールの検出と誤検出しない例、実行ファイル検出
- [ ] Commit `feat: add safe archive inspection and secret scanning`

### Task 4: デプロイの処理と公開切り替え・ロールバック

**Files:** `apps/api/src/apps/deployments.ts`、`apps/api/src/ingest/publish.ts`、`apps/worker/src/handlers/process-deployment.ts`、HTTP、テスト

**Interfaces:**
- Consumes: Task 1〜3
- Produces:
  - `createDeployment(db, storage, queue, accountId, appId, input: { source; archive: Readable; format })` → `{ deploymentId } | { error }`：ソースを `sources/<appId>/<deploymentId>.<ext>` に保存し、`queued` で記録してジョブを積む
  - ワーカーの処理：展開 → `publishDir` 配下だけを対象 → 除外 → 秘密情報 → 実行ファイル → `sites/<appId>/<deploymentId>/` に配置 → **同じアプリで自分より新しいデプロイが `live` でなければ**公開切り替え（`activeDeploymentId` 更新、前の `live` は `superseded`）。失敗時は `failed` とメッセージ
  - `listDeployments(db, accountId, appId)`、`rollback(db, accountId, appId, deploymentId)`（過去の `live`/`superseded` だけ）
  - HTTP：`POST /apps/:id/deployments`（multipart の ZIP、最大 200MB）、`GET /apps/:id/deployments`、`POST /apps/:id/deployments/:did/rollback`
  - 開発用のアップロード上限：Hono の body limit を 200MB に
- [ ] テスト：ZIP を上げると `live` になり `siteKey` に index.html がある、`publishDir: 'dist'` で dist の中だけ公開、秘密情報で `blocked_secret`（公開中は変わらない）、実行ファイルで `held_for_review`、Review Focus 3 の順序逆転、ロールバック、他人のアプリには上げられない
- [ ] Commit `feat: process deployments and switch live site`

### Task 5: 静的サイト配信と転送量

**Files:** `apps/static/`（新パッケージ、ポート 8090）、`apps/api/src/usage/transfer.ts`、スキーマ（`transfer_usage(appId, month 'YYYY-MM', bytes bigint, notified80 bool, pk)`）、i18n、テスト

**Interfaces:**
- Produces:
  - `resolveSite(host: string, baseDomain: string)` → `appName | null`（`BASE_DOMAIN` 環境変数、開発は `localhost`。ポートを無視して小文字化）
  - 配信ルール：`/` と `/dir/` は `index.html`、拡張子なしで見つからなければ `<path>.html` も試す、見つからなければサイトの `404.html`、それもなければ既定の 404。Content-Type は拡張子から。`ETag` と `Cache-Control: public, max-age=60`。ドットで始まる要素は 404（`.well-known` を除く）。`..` は 400
  - 転送量：応答バイト数をメモリで集計し、10 秒ごとに `transfer_usage` へ加算。上限判定は 30 秒キャッシュ。上限超過なら 503 ページ（日英、`Accept-Language`）。80% 到達時に一度だけ持ち主へ通知メール（チームならオーナー）
  - セキュリティヘッダ：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options` は付けない（利用者の自由）
- [ ] テスト：Review Focus 2 と 4、404.html、ドットファイル 404、`.well-known` は配信、上限超過で 503 と日英文言、80% 通知は 1 回だけ、月が変わると再開
- [ ] Commit `feat: serve static sites with transfer limits`

### Task 6: GitHub 連携

**Files:** `apps/api/src/github/{webhook,client}.ts`、HTTP、スキーマ（apps の github 列は Task 1 で作成済み）、`docs/github-app.md`、テスト

**Interfaces:**
- Produces:
  - `verifyWebhook(secret, payload: string, signature256: string | undefined): boolean`（`@octokit/webhooks-methods`）
  - `POST /github/webhook`：`push` イベントで、`installation.id` と `repository.full_name` と `ref === refs/heads/<branch>` が一致するアプリごとにデプロイを作る（ソースは `GET /repos/{owner}/{repo}/tarball/{sha}` をインストールトークンで取得）。`deleted: true` の push は無視
  - `PATCH /apps/:id/github { repo, branch, installationId }`（持ち主の deploy 権限）。インストール ID の正当性はフェーズ 2 では GitHub API で `GET /app/installations/{id}` を確認
  - 環境変数：`GITHUB_APP_ID`、`GITHUB_APP_PRIVATE_KEY`（PEM）、`GITHUB_WEBHOOK_SECRET`。未設定ならルートを登録しない
  - GitHub のリポジトリの tar は最上位に `<owner>-<repo>-<sha>/` があるので、取り除いてから処理する
  - `docs/github-app.md`：GitHub App の作り方（権限は Contents: Read-only、Metadata: Read-only、イベントは Push だけ）
- [ ] テスト：Review Focus 5、tarball の取得をモックしてデプロイが作られる、別ブランチは無視
- [ ] Commit `feat: deploy static sites from GitHub pushes`

### Task 7: CLI と API トークン

**Files:** `apps/api/src/apps/api-tokens.ts`、スキーマ（`api_tokens(id, accountId, name, tokenHash unique, prefix, createdAt, lastUsedAt, revokedAt)`）、ミドルウェア（`Authorization: Bearer` を `requireSession` と同等に扱う）、`apps/cli/`、テスト

**Interfaces:**
- Produces:
  - `createApiToken(db, accountId, name)` → `{ token: 'ysk_' + base64url(32 bytes), id }`（保存はハッシュ、表示は 1 回だけ）、`listApiTokens`、`revokeApiToken`
  - Bearer 認証では、トークン管理 API（作成・削除）と復旧関連は使えない（セッション必須）
  - CLI（`yourservice`）：`login`（トークンを貼り付け、`~/.config/yourservice/config.json` に 0600 で保存）、`apps`（一覧）、`deploy [dir] --app <name>`（`.gitignore` と常時除外を守って tar.gz を作って送る。送る前に合計サイズと件数を表示）、`logout`。API の URL は `YOURSERVICE_API`（既定 `http://localhost:3001`）
- [ ] テスト：トークンの保存はハッシュ、取り消し後は 401、Bearer ではトークン作成不可、CLI の deploy が `.env` と `.git` を含めない tar を送る（CLI はモジュール関数をテスト）
- [ ] Commit `feat: add API tokens and CLI deploy`

### Task 8: Web 画面

**Files:** `apps/web/app/[locale]/(app)/apps/page.tsx`（一覧・作成）、`apps/[id]/page.tsx`（デプロイ一覧・アップロード・ロールバック・publishDir・GitHub 設定・サイトの URL）、`settings/tokens/page.tsx`、i18n、E2E

- 状態の表示：`queued`/`processing` は 2 秒ごとに更新、`blocked_secret` は見つかったファイルと行を表示し「環境変数に移しましょう」と案内（フェーズ 3 で環境変数画面）、`held_for_review` は「運営の確認待ち」
- サイトの URL：`http://<name>.localhost:8090`（`NEXT_PUBLIC_SITE_URL_TEMPLATE`）
- [ ] E2E：ログイン → アプリ作成 → ZIP（テスト内で生成）をアップロード → `live` → サイトの URL で中身が見える、`.env` を含む ZIP でも公開され `.env` は 404、秘密情報入りは公開されない、ロールバック、トークン作成は 1 回だけ表示
- [ ] Commit `feat(web): add apps and deployments screens`

### Task 9: 開発環境と仕上げ

**Files:** `scripts/dev-up.sh`（worker と static の起動方法を案内）、ルートの `pnpm dev`（api・web・worker・static をまとめて起動。`concurrently` を使う）、`docs/dev-setup.md`（`.localhost` の説明、Safari の注意、mkcert での https）、CI（worker・static・cli のテストと e2e）

- [ ] `pnpm dev` 1 つで 4 つが立ち上がり、E2E が通ることを確認
- [ ] Commit `chore: wire phase 2 services into dev and CI`

---

## フェーズ 2 でやらないこと

- ビルド（npm run build など）とコンテナ実行 → フェーズ 3
- 無料枠・プランの判定、保留デプロイの解除画面 → フェーズ 5
- CDN、本物のドメインと証明書 → フェーズ 8
