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

## Housekeeping

`pnpm --filter api admin:purge` deletes expired/revoked sessions (30 days idle, 90 days absolute), old login events and spent WebAuthn challenges.

## CI

`.github/workflows/ci.yml` を参照。ubuntu は PostgreSQL / Mailpit をサービスコンテナで起動して全テストと E2E を実行します。macOS は Docker が無いため lint・typecheck と shared / i18n のテストのみです。gitleaks（設定は `.gitleaks.toml`）と `pnpm audit --audit-level=high` も実行します。依存更新は Renovate（`renovate.json`）が毎週月曜 6 時前にまとめて PR を作ります。
