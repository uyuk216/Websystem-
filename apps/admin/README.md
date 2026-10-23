# 運営管理画面（日本語のみ）

既存の workspace 依存関係を使う。追加インストールは不要。
`pnpm --filter admin dev` で UI（既定 localhost:5175）と専用管理 API（localhost:3002）を起動する。
公開 API プロセスは管理 API を起動しない。設定は既存 `.env.development` と分離した `.env.pii.development` を読む。
審査用の接続がなければ画像表示・審査決定は 503 で拒否する。
本番では管理用インターフェースに bind し、Tailscale の既存ゲートを通す。開発でのみ `ADMIN_DEV_TAILSCALE=1` を使える。
画面と `/admin/*` は同一オリジンに置く（UI サーバーは API を代理しない）。

パスキーで昇格後、審査・付与・利用者・設定・記録を操作する。設定と付与・利用者操作は owner のみ。
画像の「ローカル秘密鍵ファイル」は keygen で得た秘密鍵の base64 テキストを選ぶ。秘密鍵と平文画像はサーバーに送らず、保存もしない。
`DecryptViewer` は `Decryptor` を受け取るため、外部コマンド用アダプターに差し替えられる。YubiKey 実機の接続・検証は対象外。
画像は閉じる・画面切替・ページを隠す・30 秒無操作で破棄し、復号後のバッファはゼロ埋めする。
右クリックとドラッグ保存を抑止するが、スクリーンショットなど OS 側の取得は防げない。
ブロック・停止・凍結は既存の動的アプリ停止経路に従う。静的配信・DB・イメージ・データは維持する。
凍結解除は owner が24時間後に予約し、worker の `admin.dangerous-execute`（毎分）で実行する。予約の取消も可能。

検証:
- `pnpm --filter admin test --testTimeout=30000`
- `pnpm --filter upload exec playwright test --config=../admin/playwright.config.ts`

E2E は既存の upload の Playwright/esbuild を再利用し、本体と審査用の使い捨てDB・本物の提出画面・ソフトウェアパスキーを使う。
開発用のテストエンドポイントは `e2e/server.ts` のみで、本番の起動経路には含まれない。
