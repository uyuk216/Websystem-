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

### Phase 5: プランと学生審査

利用者は `/ja/plan`（英語は `/en/plan`）でプラン・期限・停止日を確認できます。
学生審査は `/ja/verify` から始めます。学校の情報を入力した後、別オリジンの提出画面へ進みます。
学生証の画像はブラウザで暗号化してから送信され、審査後すぐ、未審査でも7日で削除されます。
運営がメールで画像や学生証番号を求めることはありません。

`pnpm dev` は従来のサービスに加え、管理画面（localhost:5175、専用 API :3002）と
提出画面（localhost:5174）を起動します。先に `pnpm dev:up --no-k8s` で開発用 DB を準備し、
`.env.development.example` と `.env.pii.development.example` に従って設定してください。
`pnpm --filter upload keygen` で鍵を作り、公開鍵だけを `ID_RECIPIENT_PUBLIC_KEY` に設定します。
秘密鍵は運営者が安全な場所で保管し、環境変数やリポジトリには入れません。
`UPLOAD_ORIGIN=http://localhost:5174` と、API・提出側で一致する `INGEST_SHARED_SECRET` が必要です。
個人情報 DB の接続先は `.env.pii.development` だけに設定します。

管理画面は公開 API と別のプロセスです。開発時だけ `ADMIN_DEV_TAILSCALE=1` で
ループバックからの接続を許可できます（本番では起動時に拒否されます）。
画面と `/admin/*` は同じオリジンに配置し、開発時も Tailscale serve で専用 API と画面を振り分けます。
`ADMIN_ORIGIN` とパスキーの `RP_ID` を、そのアクセス先に合わせてください。
API ゲートには登録した `Tailscale-User-Login` も必要です。開発用の IP 許可だけではログインできません。
詳細は [管理画面の手順](apps/admin/README.md) を参照してください。

運営者の登録はサーバー上の端末だけで行います。まず通常のアカウントを作り、パスキーを登録し、
DB 管理者がそのアカウント UUID を確認してください。次をリポジトリ直下で実行します。

```sh
pnpm --filter api exec node --env-file-if-exists=../../.env.development --import tsx src/scripts/add-operator.ts <account-uuid> <tailscale-login> <owner-or-reviewer>
```

最後の引数は `owner`（設定・付与・利用者操作も可能）か `reviewer`（審査担当）です。
既存の運営者の上書きは行いません。登録は監査記録に残ります。
本番の Tailscale 設置・公開範囲の設定は Phase 8、実機での鍵の利用確認は別途行います。
`ExternalCommandDecryptor` を使う場合は、端末側の連携処理で封筒の復号を担当させ、
管理画面の `DecryptViewer` にその `Decryptor` を渡します。現在の画面の鍵ファイル選択は
`LocalKeyDecryptor` 用で、ブラウザから外部コマンドを直接実行する機能はありません。
