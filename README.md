# Websystem-

学生向け PaaS（TypeScript pnpm モノレポ）。フェーズ 1 では認証（パスキー / メール）・API・Web の土台を作っています。

| パッケージ | 役割 |
| --- | --- |
| `apps/api` | API サーバー（PostgreSQL / Drizzle） |
| `apps/web` | Web フロントエンド（Next.js、E2E は Playwright） |
| `packages/shared` | 共有コード |
| `packages/i18n` | 多言語メッセージ |

## ドキュメント

- 開発環境のセットアップ: [docs/dev-setup.md](docs/dev-setup.md)
- 設計書: [docs/superpowers/specs/2026-10-15-platform-design.md](docs/superpowers/specs/2026-10-15-platform-design.md)
- フェーズ 1 計画: [docs/superpowers/plans/2026-10-15-phase1-foundation.md](docs/superpowers/plans/2026-10-15-phase1-foundation.md)

## テスト

```bash
pnpm install
pnpm dev:up --no-k8s     # PostgreSQL / Mailpit / MinIO を起動（k3d は不要なら省略可）
pnpm lint && pnpm typecheck
pnpm test                # 全パッケージの単体・結合テスト（api は PostgreSQL が必要）
pnpm --filter web e2e    # Playwright の E2E（API と Web を自動で起動し、Mailpit のメールを読む）
```

E2E には Chromium が必要です。既定の場所は `/opt/pw-browsers/chromium` で、変えるときは `CHROMIUM_PATH` を指定します。
CI（GitHub Actions）では ubuntu で全部、macOS では lint / typecheck / DB 不要の単体テストだけを実行します（macOS ランナーでは Docker が使えないため）。
