# フェーズ 3（動的アプリ）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Node / Python / PHP のアプリ、または Dockerfile を含む任意のアプリをデプロイして、`http://<アプリ名>.localhost:8090` で動かす。環境変数、スリープと自動起動、稼働時間の計測と上限、ログとアクセスログ、ロールバックを含める。

**Architecture:** 実行環境は `RuntimeDriver` インターフェースで抽象化する。**Docker ドライバ**（開発・テスト用、実際に動かす）と **Kubernetes ドライバ**（本番用、マニフェストを生成して適用する）の 2 つを用意する。ワーカーがソースからイメージをビルドしてドライバに起動を頼み、静的配信サーバー（`apps/static`）を**エッジルーター**に広げて、動的アプリへのリクエストをプロキシする。アクセスがなければ 15 分でスリープ（コンテナ 0 個）にし、次のリクエストで起こす。

**Tech Stack:** 既存に加えて dockerode（Docker API）、@kubernetes/client-node（マニフェスト適用）、http-proxy などの Node 標準のプロキシ実装。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（3 章、5.2〜5.4、9.2）

## Global Constraints

- 動的アプリの初期値（`packages/shared/src/plans.ts` に追加）：**メモリ 512MB、CPU 0.5、プロセス数 256、アプリ 1 つ（持ち主ごと）、月 240 時間、年度（4/1〜3/31）2,000 時間、スリープまで 15 分、ビルド時間 15 分、イメージ 1GB まで**。プランの判定はフェーズ 5（それまでは全員に適用）。
- 稼働時間：**1 分ごとに、動いているコンテナ数を記録**（生の記録を残す）。コンテナ 1 つが 1 時間で「1 時間」。スリープ中は数えない。
- 上限到達：月 → 月末まで停止し、翌月 1 日に自動で再開。年度 → 3 月 31 日まで停止。80% で通知。停止中のアクセスには 503 と「今月の稼働時間の上限に達しました」ページ（日英）。**自動課金はしない**。
- コンテナの隔離（両ドライバ共通の必須設定）：root 以外のユーザーで実行、**すべての Linux capability を削除**、`no-new-privileges`、ルートファイルシステムは読み取り専用（`/tmp` だけ書き込み可の tmpfs 64MB）、メモリ・CPU・プロセス数の上限、特権コンテナ禁止。Kubernetes ではさらに `runtimeClassName: gvisor`、ユーザーごとの名前空間、NetworkPolicy（他の名前空間・本体・`169.254.169.254` へ出られない、ポート 25 禁止）。Docker ドライバでは `RUNTIME=runsc` が設定されていれば gVisor を使い、なければ警告を出して runc で動かす（開発用）。Docker ドライバでも `169.254.169.254` への通信は遮断する。
- ビルド：**Dockerfile があればそれを使う**。なければ言語を判定して Dockerfile を自動生成する（Node：`package.json` の `start` スクリプト、Python：`requirements.txt` と `app.py`／`main.py` を gunicorn か uvicorn で、PHP：`index.php` を php-apache で）。Cloud Native Buildpacks はフェーズ 8 で検討する（イメージが重くオフラインのテストに向かないため）。ビルド前に秘密情報チェックと実行ファイルの保留（フェーズ 2 と同じ）。ビルドはネットワークあり・時間とメモリに上限・ビルドログを保存。
- アプリは環境変数 `PORT`（既定 8080）で待ち受けること。ヘルスチェックは `GET /`（2xx〜4xx を正常とする）で、30 秒以内に応答がなければ失敗。失敗したら前のバージョンを動かし続ける。
- 環境変数：アプリごとに暗号化（AES-256-GCM、鍵は `APP_ENV_KEY`）して保存。値は画面・API で再表示しない（名前と更新日時だけ）。`PORT` などの予約名は設定できない。
- アクセスログ（静的・動的の両方）：日時、メソッド、パス、ステータス、応答バイト数、User-Agent の種類、参照元、**IP は IPv4 /24・IPv6 /48 に丸める**。30 日で削除。持ち主だけ見られる（RLS）。
- アプリのログ（stdout / stderr）：最新 1,000 行を保持し、画面と CLI（`yourservice logs`）で見られる。
- 認証が必要な処理は `withAccount`、ワーカー・エッジは `withSystem`。新しいテーブルには RLS。文言は日英。

## Review Focus

1. **スリープ中のアプリに同時に 100 リクエスト** → 起動は 1 回だけ、全員が起動後に応答を受ける（30 秒を超えたら 503）。Task 4 のテストで固定。
2. **アプリが `PORT` を無視する・すぐ落ちる・ヘルスチェックに通らない** → デプロイは `failed`、前のバージョンが動き続け、理由がログで見える。Task 3 のテストで固定。
3. **ビルド中に無限ループ／巨大なイメージ／ビルドログの大量出力** → 15 分・1GB・ログ 5MB で打ち切って `failed`。Task 2 のテストで固定。
4. **稼働時間の記録が重複・欠落する**（ワーカーが 2 つ、記録処理が遅れる） → 1 分につき 1 件（`(appId, minute)` の一意制約）。Task 5 のテストで固定。
5. **環境変数に改行・`=`・巨大な値・予約名** → 改行と予約名は拒否、値は 32KB まで、合計 64KB まで。Task 6 のテストで固定。

---

### Task 1: RuntimeDriver と Docker ドライバ

**Files:** `packages/platform/src/runtime/{driver,docker,kubernetes-manifests}.ts`、テスト

**Interfaces:**
- `interface RuntimeDriver { ensureImage? ; start(spec: AppRunSpec): Promise<RunHandle>; stop(appId): Promise<void>; status(appId): Promise<'running'|'stopped'|'starting'|'crashed'>; endpoint(appId): Promise<{ host: string; port: number } | null>; logs(appId, tail: number): Promise<string[]>; runningCount(): Promise<Array<{ appId: string; containers: number }>> }`
- `AppRunSpec = { appId, ownerId, image, env: Record<string,string>, limits: { memoryMb, cpu, pids } , port: number }`
- Docker ドライバ：dockerode。コンテナ名 `ys-app-<appId>`、ラベル `ys.app=<appId>`、ネットワーク `ys-apps`（ホスト側は 127.0.0.1 のランダムなポートだけに公開）、Global Constraints の隔離設定をすべて付ける。`169.254.169.254` は `--add-host` で 0.0.0.0 に向けて無効化し、可能なら iptables の注意をドキュメントへ
- `buildKubernetesManifests(spec): object[]`：Namespace（`ys-o-<ownerId 先頭 12 文字>`）、Deployment、Service、NetworkPolicy、ResourceQuota、`runtimeClassName: gvisor`、securityContext。適用処理（Kubernetes ドライバ本体）は Task 8
- [ ] テスト：Docker ドライバで小さな HTTP サーバー（busybox httpd など、テスト内でイメージを作る）を起動して応答を確認、隔離設定がコンテナの inspect 結果に反映されている（`CapDrop: ALL`、`ReadonlyRootfs`、`SecurityOpt` に no-new-privileges、メモリ・PIDs の上限、User が root でない）、stop・status・logs。マニフェストのスナップショットテストと、securityContext・NetworkPolicy の必須項目のテスト
- [ ] Commit `feat: add runtime driver with docker implementation`

### Task 2: ビルド

**Files:** `packages/platform/src/build/{detect,dockerfiles,build}.ts`、ワーカーのハンドラ、スキーマ（`apps.kind` に `'dynamic'` を追加、`deployments.imageRef`、`deployments.buildLogKey`）、テスト

**Interfaces:**
- `detectStack(files: string[], readFile): { kind: 'dockerfile' } | { kind: 'node' | 'python' | 'php'; dockerfile: string } | { error: 'unknown_stack' }`
- `buildImage(contextDir, { tag, timeoutMs: 15 * 60_000, maxImageBytes: 1024 ** 3, maxLogBytes: 5 * 1024 ** 2 }) → { ok: true; imageRef; sizeBytes } | { ok: false; reason: 'timeout' | 'too_large' | 'build_failed'; log }`（Docker ドライバでは docker build。ビルドログは MinIO の `sources/<appId>/<deploymentId>.build.log`）
- 動的アプリのデプロイ処理：展開 → 秘密情報・実行ファイル（静的と同じ）→ ビルド → Task 3 の起動へ
- [ ] テスト：Node・Python・PHP・Dockerfile の判定と生成された Dockerfile の内容（root 以外の USER を含む）、実際にビルドして起動できる（Node の最小アプリ）、Review Focus 3
- [ ] Commit `feat: build images for dynamic apps`

### Task 3: 起動・ヘルスチェック・切り替え・ロールバック

**Files:** `apps/api/src/apps/deployments.ts`（動的アプリ対応）、`packages/platform/src/runtime/rollout.ts`、テスト

- 新しいイメージで新しいコンテナを起動 → ヘルスチェック（30 秒）→ 合格なら切り替えて古いコンテナを停止、不合格なら新しいコンテナを停止して `failed`（理由とログ末尾を保存）。フェーズ 2 の順序規則（新しい作成日時が勝つ、`rolled_back_at`）をそのまま使う
- ロールバックは、過去のイメージでもう一度起動する
- アプリ削除時はコンテナとイメージも削除する
- [ ] テスト：Review Focus 2、切り替え中も古いバージョンが応答し続ける、ロールバック
- [ ] Commit `feat: roll out dynamic deployments with health checks`

### Task 4: エッジルーター・スリープと自動起動

**Files:** `apps/static`（動的アプリへのプロキシを追加）、`packages/platform/src/runtime/waker.ts`、テスト

- アプリの種類が dynamic なら、ドライバの `endpoint` へプロキシする（`X-Forwarded-For` を付ける、`Host` は元のまま、WebSocket の Upgrade も通す）
- 停止中ならワーカー経由ではなく、エッジから直接 `start` を 1 回だけ呼び（アプリ単位のロック）、起動を待つ（最大 30 秒、超えたら 503 と日英のページ）
- 最後のリクエストから 15 分たったら停止（エッジがアプリごとの最終アクセス時刻を DB に 1 分ごとに書き、ワーカーが 1 分ごとに確認して `stop`）
- 転送量の計測と上限（フェーズ 2）を動的アプリにも適用
- [ ] テスト：Review Focus 1、スリープ → 起動、WebSocket、転送量
- [ ] Commit `feat: proxy dynamic apps with sleep and wake`

### Task 5: 稼働時間の計測と上限

**Files:** `packages/platform/src/usage/runtime-hours.ts`、ワーカーの定期処理、スキーマ（`runtime_minutes(appId, minute timestamptz, containers int, primary key (appId, minute))`、`runtime_usage(ownerId, period 'YYYY-MM' | 'FY2026', minutes, notified80)`）、i18n、テスト

- 1 分ごとに `runningCount()` を記録（一意制約で重複しない）
- 月・年度の集計は持ち主（個人またはチーム）単位。上限に達したら持ち主の動的アプリをすべて停止し、エッジは 503 を返す。翌月 1 日（年度なら 4 月 1 日）に自動で解除
- 80% で一度だけ通知
- `GET /apps/:id/usage` に稼働時間を追加
- [ ] テスト：Review Focus 4、月と年度の上限、月・年度の境界（UTC ではなく **Asia/Tokyo** で区切る。年度は 4/1 0:00 JST 開始）
- [ ] Commit `feat: meter runtime hours and enforce limits`

### Task 6: 環境変数

**Files:** `apps/api/src/apps/env-vars.ts`、スキーマ（`app_env_vars(appId, name, valueEnc, updatedAt, pk(appId,name))`、RLS）、HTTP、CLI（`yourservice env set/unset/list`）、テスト

- 名前は `^[A-Z_][A-Z0-9_]{0,63}$`、予約名（`PORT`、`HOST`、`YS_*`）は拒否。Review Focus 5 の上限
- 変更しても自動で再デプロイはしない（画面で「再起動して反映」ボタン → 今のイメージで再起動）
- [ ] テスト：Review Focus 5、暗号化されて保存（DB に平文がない）、一覧に値が出ない、他人のアプリには設定できない
- [ ] Commit `feat: add encrypted app environment variables`

### Task 7: ログとアクセスログ

**Files:** `apps/api/src/apps/logs.ts`、スキーマ（`access_logs`、RLS、30 日で削除する処理を purge に追加）、エッジでの記録（まとめて書き込み）、HTTP、CLI（`yourservice logs`）、テスト

- [ ] テスト：IP の丸め、30 日の削除、他人のログは見えない、アプリログの tail
- [ ] Commit `feat: add app logs and access logs`

### Task 8: Kubernetes ドライバ・Web 画面・開発環境

**Files:** `packages/platform/src/runtime/kubernetes.ts`（マニフェストを適用・削除・状態取得）、Web（アプリ作成で種類を選ぶ、環境変数、ログ、アクセスログ、稼働時間の表示、再起動）、E2E（Node の最小アプリをアップロード → 起動 → 応答 → スリープ → 自動起動）、`docs/dev-setup.md`（`RUNTIME_DRIVER=docker|kubernetes`、Mac で k3d と gVisor を試す手順。この環境では k3d が起動しないため未検証と明記）、CI

- [ ] Kubernetes ドライバは @kubernetes/client-node のモックでテストする
- [ ] Commit を機能ごとに分ける

---

## フェーズ 3 でやらないこと

- 利用者向けの DB（フェーズ 4）、プラン・審査（フェーズ 5）、Falco などの監視（フェーズ 6）
- Cloud Native Buildpacks、本番の BuildKit（フェーズ 8）
