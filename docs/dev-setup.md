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

MinIO の公式イメージ（Docker Hub・quay.io）は匿名で取得できなくなったため `chainguard/minio:latest` を使います。
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

アプリの Pod は既定で RuntimeClass `gvisor` を使います。gVisor を入れていない開発用クラスタでは `K8S_RUNTIME_CLASS=none` を設定してください（警告を出して runc で動かします。本番では使わないこと）。別の RuntimeClass 名も指定できます。

健康確認：Kubernetes ドライバでは、アプリの Pod に readinessProbe（`PORT` で接続を受け付けるか）を付け、Pod が Ready になったことを「正常」とみなします（`waitHealthy` はクラスタ外からは名前を引けない Service に接続しない）。Docker ドライバの「`GET /` が 2xx〜4xx」より弱く、5xx を返し続けるアプリも正常と判定される点に注意。

イメージ：`IMAGE_REGISTRY` を設定すると、ワーカーはビルドしたイメージをそのレジストリへ push し、そこから起動します（クラスタは Mac の Docker のイメージを見られないため）。

### Mac の k3d で通しで試す

`pnpm dev:up` が作る `tenant` クラスタで、gVisor・レジストリ・クラスタ内のエッジまで含めて動かせます（2026-10-18 に確認）。

```bash
bash scripts/k3d-gvisor.sh     # gVisor（runsc）をノードに入れ、RuntimeClass gvisor を作る（公式配布物を SHA-512 で確認）
bash scripts/k3d-registry.sh   # イメージ置き場 localhost:5050 を作り、クラスタから取れるようにする
bash scripts/k3d-edge.sh       # エッジを ys-system で動かす（.env.development から設定を作る。Mac の http://localhost:8081）
RUNTIME_DRIVER=kubernetes IMAGE_REGISTRY=localhost:5050 K8S_RUNTIME_CLASS=gvisor pnpm dev
```

動的アプリを作って ZIP をアップロードすると、ワーカー（Mac）がビルドして push し、持ち主の名前空間に gVisor で起動します。アクセスは `curl -H 'Host: <アプリ名>.localhost' http://localhost:8081/`。確認できたこと：

- ビルド → push → 起動 → クラスタ内のエッジ経由の応答（設定値が渡る）
- スリープ（Pod 0 個）→ 次のアクセスで約 3 秒で起動。眠っているアプリへの同時 50 件でも起動は 1 回、全員 200
- アクセスの記録・稼働時間の記録
- NetworkPolicy：アプリへは `ys-system` からだけ届く。アプリからは DNS・80/443 だけ出られ、25 番・`169.254.169.254`・ほかの名前空間・Kubernetes API・Mac の DB へは出られない
- エッジの入れ替え中もエラーなし（preStop で 5 秒待ってから止める）

注意：

- `k3d-gvisor.sh` と `k3d-registry.sh` はノードを再起動します。k3s は再起動時に CoreDNS の `host.k3d.internal` を消すので、`k3d-edge.sh` が毎回登録し直します。
- 新しく作った Pod は、数秒間 NetworkPolicy の「`ys-system` から」に含まれないことがあります（kube-router の反映待ち）。常駐するエッジには影響しません。
- k3d では入口（ロードバランサー）で送信元が書き換わるため、アクセスの記録の IP は Mac ではなくクラスタ内の入口のものになります。エッジは `EDGE_TRUSTED_PROXY_HOPS`（k3d では 1）だけ `X-Forwarded-For` を信用します。本番は入口で送信元を保つ設定が必要（フェーズ 8）。
- ワーカーと API は Mac で動かしています。クラスタ内でのビルド（rootless BuildKit）はフェーズ 8。

## 利用者向けのデータベース

動的アプリの画面の「データベースを追加」で、アプリ専用の PostgreSQL ができ、接続先が `DATABASE_URL` としてアプリに渡ります（同じ名前の設定値より優先）。容量 256MB・接続 10 まで。80% でメール、100% で読み取り専用、110% で接続も止めます。1 時間ごとにバックアップを取り（ストレージの `<appId>/db-backups/`）、7 日間残します。画面から好きなバックアップに戻せます（戻す直前の状態も自動で保存）。

- **Docker ドライバ**（`RUNTIME_DRIVER` が `docker` のとき）：アプリごとに `postgres:16-alpine` のコンテナ `ys-db-<appId>` を、外へ出られない専用ネットワーク `ys-dbnet-*` に作り、アプリのコンテナもそこに参加させます。ホストにポートは公開しません。
- **Kubernetes ドライバ**：CloudNativePG の `Cluster` を持ち主の DB 用名前空間 `ys-d-<ownerId>` に作り、NetworkPolicy でそのアプリの Pod からだけつながるようにします。`DB_BACKUP_S3_PATH`（例 `s3://user-db-backups`）を設定すると、CloudNativePG の継続バックアップ（7 日保持）も有効になります。

外から中身を見るときは CLI の `yourservice db connect --app <名前>` を使います。API が 1 時間だけ有効な一時的なログイン（アプリの役割の権限を引き継ぐ）を発行し、`127.0.0.1:15432` への接続を API 経由で DB へ中継します（Docker ではその DB 専用ネットワークに一時的な中継コンテナを作り、Kubernetes では API のポート転送を使います）。期限切れのログインは容量の見張りが 5 分ごとに削除します。

k3d で試すときは、先に CloudNativePG のオペレーターを入れます（2026-10-18 に v1.30.1 で確認：作成約 1 分、アプリからの接続、別アプリからは届かない、読み取り専用、バックアップと復元、削除）。

```bash
kubectl --context k3d-tenant apply --server-side -f https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.1/cnpg-1.30.1.yaml
```

## 動的アプリのビルド

- 開発・テストではクラシックビルダー（`DOCKER_BUILDKIT=0`）で `docker build` を実行する。ビルド手順のコンテナにメモリ 1GB（スワップ込み）・CPU 1 を適用でき、BuildKit では効かないため。
- ビルドは専用ブリッジ `ys-build`（`enable_icc=false`）で行い、ビルド手順どうしは通信できない。外向き通信は許可（`npm install` などのため）。
- ビルドごとに `--cgroup-parent ys-build-<deploymentId>` とラベル `ys.build=<deploymentId>` を付け、タイムアウト・失敗時はそのビルドのコンテナと途中のレイヤーだけを削除する（他のコンテナは触らない）。タイムアウトは SIGINT のあと 10 秒で SIGKILL。
- 15 分・イメージ 1GB・ログ 5MB で打ち切る。失敗したデプロイのイメージ `ys/<appId>:<deploymentId>` は削除する。
- 制限事項：ビルド中のディスク使用量は Docker 側では制限できない（ビルドコンテキストの大きさはアップロード時に制限済み、イメージは完成後に 1GB で判定）。ビルド中にディスクを埋める手順は開発環境では防げない。
- 本番は Kubernetes 上の隔離された rootless BuildKit（ephemeral-storage の上限つき）で行う（フェーズ 8）。
