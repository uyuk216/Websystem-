# 開発環境のセットアップ

## 必要なもの

Docker、Node.js 22 以上、pnpm 10、k3d（Kubernetes を使わないなら不要）。
足りないものは `pnpm doctor` が OS に合わせたインストール方法つきで教えてくれます。

## Mac (Apple Silicon / Intel)

```bash
brew install --cask docker   # 起動しておく
brew install node@22 pnpm k3d
```

## Ubuntu 22.04 以降

```bash
# Docker: https://docs.docker.com/engine/install/ubuntu/
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
corepack enable && corepack prepare pnpm@10 --activate
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash
```

## 使い方

```bash
pnpm install
pnpm dev:up              # PostgreSQL / MinIO / Mailpit と k3d クラスタ(platform, tenant)を起動
pnpm dev:up --no-k8s     # k3d を使わない
pnpm dev:down            # 停止（データは残る）
pnpm dev:down --purge    # 停止してデータ(ボリューム)も削除
pnpm doctor              # ツールの確認だけ行う
```

初回は `.env.development.example` が `.env.development` にコピーされます（コミットしないこと）。
`apps/api` ができるまで `db:migrate` は自動でスキップされます。

`pnpm dev:up` のあと、`pnpm dev` 1 つで api(:3001)・web(:5173)・worker・static(:8090) がまとめて起動します（`concurrently`、Ctrl+C で全部停止）。個別に動かす場合は `pnpm --filter <api|web|worker|static> dev`。

## 接続先

| サービス | 接続先 |
| --- | --- |
| PostgreSQL | `postgres://platform:platform@localhost:54320/platform` |
| Mailpit | SMTP `localhost:1025` / 画面 http://localhost:8025 |
| MinIO | http://localhost:9000 （コンソール http://localhost:9001, `minioadmin`/`minioadmin`） |
| k3d platform | ロードバランサ `localhost:8080` |
| k3d tenant | ロードバランサ `localhost:8081`（エージェント 1 台。フェーズ 3 で gVisor を導入） |

## メモ

MinIO のイメージは Docker Hub での配布が終わったため `quay.io/minio/minio` を使います。
取得できない環境では `MINIO_IMAGE=<イメージ名> pnpm dev:up` で差し替えられます。

## TRUSTED_PROXY_HOPS

API の IP 単位のレート制限が使うクライアント IP の決め方を指定します。

- `0`（コード上の既定）：ソケットの接続元アドレスを使い、`X-Forwarded-For` は無視します。
- `N`（1 以上）：`X-Forwarded-For` の右から N 番目の値を使います（信頼できるプロキシが N 段ある場合）。

開発環境（`.env.development.example`）の既定は `1` です。ブラウザからの API 呼び出しは Next の `/api` リライト（1 段のプロキシ、`X-Forwarded-For` を付与）を経由するためです。0 のままだと全クライアントがリライトの接続元（同一 IP）を共有し、IP 単位の制限が全体で 1 つになります。この設定のとき API（:3001 など）へ直接アクセスしてレート制限を試さないでください（`X-Forwarded-For` を自由に偽装できます）。

本番では実際のプロキシ段数（Cloudflare / Traefik など）を必ず設定してください。段数が実際より少ないと全クライアントがプロキシの IP を共有し、多いと偽装を許します。

## Row Level Security and database roles

Migrations 0006/0007 enable and FORCE RLS on accounts, owners, sessions, passkeys, login_events, teams, team_members and team_invites; `platform_api` has no privileges on email_challenges, recovery_requests, recovery_attempts and webauthn_challenges (pre-auth tables, owner role only). The API runs authenticated queries as the NOLOGIN role `platform_api` (via `SET LOCAL ROLE`). Pre-auth flows and admin scripts (`withSystem`) run as the connecting owner role, so in production that role must be a SUPERUSER or have BYPASSRLS, and be allowed to `SET ROLE platform_api` (the migration grants this). The API checks this at startup and refuses to start otherwise.

## Static site server and BASE_DOMAIN

`apps/static` (port `STATIC_PORT`, default 8090) serves `http://<app>.<BASE_DOMAIN>:8090` (dev: `<app>.localhost:8090`). Uploaded sites run arbitrary JavaScript, so `BASE_DOMAIN` must be a registrable domain separate from the one used by `APP_ORIGIN` / `RP_ID`; in production it should be listed on the Public Suffix List so browsers isolate each site's cookies and storage. Session cookies are host-only (no `Domain` attribute; covered by a test), so they are never sent to `*.BASE_DOMAIN`.

### `.localhost` でサイトを開く

アップロードしたサイトは `http://<アプリ名>.localhost:8090` で開きます。`*.localhost` は常に自分のマシン（127.0.0.1）を指す予約名なので、`/etc/hosts` や DNS の設定は不要です。

- Chrome / Firefox / Edge：そのまま開けます。
- Safari：サブドメイン付きの `*.localhost` を解決できないことがあります。その場合は Chrome / Firefox を使うか、`/etc/hosts` に `127.0.0.1 <アプリ名>.localhost` を追加してください。
- https が必要なとき（Service Worker など）：[mkcert](https://github.com/FiloSottile/mkcert) でローカル CA を入れ（`mkcert -install`）、`mkcert "*.localhost" localhost` で証明書を作ってリバースプロキシ（Caddy など）に設定します。dev サーバー自体は http のみです。

## Housekeeping

`pnpm --filter api admin:purge` deletes expired/revoked sessions (30 days idle, 90 days absolute), old login events and spent WebAuthn challenges.

## CI

`.github/workflows/ci.yml` を参照。ubuntu は PostgreSQL / Mailpit をサービスコンテナ、MinIO を `docker run` で起動し、バケットを作成してから全テスト（api・worker・static・cli を含む）と E2E（worker・static も一緒に起動）を実行します。macOS は Docker が無いため lint・typecheck と shared / i18n のテストのみです。gitleaks（設定は `.gitleaks.toml`）と `pnpm audit --audit-level=high` も実行します。依存更新は Renovate（`renovate.json`）が毎週月曜 6 時前にまとめて PR を作ります。

## 動的アプリのランタイム（Docker ドライバ）

開発では `packages/platform/src/runtime/docker.ts` がアプリを `ys-apps` ブリッジネットワーク上のコンテナ（`ys-app-<appId>`）として起動します。ホスト側へは `127.0.0.1` のランダムなポートだけを公開し、root 以外のユーザー・全 capability 削除・`no-new-privileges`・読み取り専用ルート（`/tmp` のみ 64MB tmpfs）・メモリ／CPU／PID 上限を付けます。ワーカーと API は `APP_ENV_KEY`（32 バイトの base64）が無いと動的ランタイムを有効にできず起動時にエラーになります（`DYNAMIC_RUNTIME=off` で無効化）。`RUNTIME=runsc` を設定すると gVisor で動かし、未設定なら警告を出して runc で動かします（開発用）。

注意：Docker では `--add-host` で IP リテラル `169.254.169.254` を無効化できません。クラウド上のホストでメタデータサービスを遮断するには、ホスト側で次を設定してください（本番は Kubernetes の NetworkPolicy が `169.254.169.254/32` とポート 25 を遮断します）。

```bash
sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
sudo iptables -I DOCKER-USER -p tcp --dport 25 -j DROP
```

`ys-apps` は `com.docker.network.bridge.enable_icc=false` で作成され、アプリ同士は通信できません（既存のネットワークが無効化されていない場合は、コンテナがなければ自動で作り直します）。コンテナ名は `ys-app-<appId>-<deploymentId 先頭 8 文字>` で、同じアプリの新旧デプロイを同時に動かせます。

## 動的アプリのランタイム（Kubernetes ドライバ）

`RUNTIME_DRIVER=kubernetes` を設定すると、API とワーカーは `packages/platform/src/runtime/kubernetes.ts` を使います（既定は `docker`）。起動のたびに `buildKubernetesManifests` のマニフェストを server-side apply し、次のものを作ります。

- 持ち主ごとの Namespace（`ys-o-<ownerId>`、Pod Security `restricted`）
- デプロイごとの Deployment と Service（`ys-app-<appId>-<deploymentId 先頭 8 文字>`）
- NetworkPolicy・ResourceQuota・LimitRange

アプリには Service の DNS 名（`<名前>.<namespace>.svc.cluster.local`）でつなぐので、エッジ（`apps/static`）はクラスタ内の `ys-system` 名前空間で動かす必要があります。NetworkPolicy が受け付けるのはこの名前空間からの通信だけです。認証情報はクラスタ内ならサービスアカウント、外なら `KUBECONFIG`（または `~/.kube/config`）から読みます。

Mac で試す手順は次のとおりです（**未検証**：開発用のコンテナでは k3d が起動しなかったため、テストは `@kubernetes/client-node` をモックにしたものだけです）。

```bash
k3d cluster create ys --agents 1
kubectl create namespace ys-system
# gVisor を使う場合は、ノードに runsc を入れて RuntimeClass "gvisor" を作る。
# 入れない場合、マニフェストの runtimeClassName: gvisor のせいで Pod が起動しない。
RUNTIME_DRIVER=kubernetes pnpm dev
```

イメージはクラスタから取得できる必要があります（k3d なら `k3d image import <イメージ> -c ys`、本番はレジストリ）。開発でビルドしたイメージはそのままでは k3d から見えない点に注意してください。

## 動的アプリのビルド

- 開発・テストではクラシックビルダー（`DOCKER_BUILDKIT=0`）で `docker build` を実行する。ビルド手順のコンテナにメモリ 1GB（スワップ込み）・CPU 1 を適用でき、BuildKit では効かないため。
- ビルドは専用ブリッジ `ys-build`（`enable_icc=false`）で行い、ビルド手順どうしは通信できない。外向き通信は許可（`npm install` などのため）。
- ビルドごとに `--cgroup-parent ys-build-<deploymentId>` とラベル `ys.build=<deploymentId>` を付け、タイムアウト・失敗時はそのビルドのコンテナと途中のレイヤーだけを削除する（他のコンテナは触らない）。タイムアウトは SIGINT のあと 10 秒で SIGKILL。
- 15 分・イメージ 1GB・ログ 5MB で打ち切る。失敗したデプロイのイメージ `ys/<appId>:<deploymentId>` は削除する。
- 制限事項：ビルド中のディスク使用量は Docker 側では制限できない（ビルドコンテキストの大きさはアップロード時に制限済み、イメージは完成後に 1GB で判定）。ビルド中にディスクを埋める手順は開発環境では防げない。
- 本番は Kubernetes 上の隔離された rootless BuildKit（ephemeral-storage の上限つき）で行う（フェーズ 8）。
