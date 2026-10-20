# フェーズ 5（管理画面と審査）実装計画

**Goal:** 運営者が Tailscale 越しの管理画面（`apps/admin`）で、学生証の審査・付与（Student / Starter Grant / イベントブースト）・停止と解除を行えるようにする。利用者は専用の小さな画面（`apps/upload`）で学生証を**ブラウザ内で暗号化**して提出する。承認すると Student の付与ができ、プランの上限（稼働時間・転送量・容量・DB）が付与に応じて変わる。利用の状態遷移（有効 / 猶予中 / 停止中 / ブロック中 / 凍結）は 1 か所に集める。

**Architecture:**

- **個人情報 DB（別 DB・別ロール）**：学生証の暗号文と審査の記録は、本体 DB（`platform_api` ロール）とは別の PostgreSQL（開発では別コンテナ `ys-pii-db`）に置く。接続情報を持つのは `apps/admin` のサーバー側と、暗号文を受け取る小さな取り込み口だけ。**利用者向けの `apps/api` は接続の文字列も権限も持たない**（スペック 9.3）。
- **ブラウザ内暗号化**（`packages/shared/src/idcrypt/`）：ハイブリッド KEM（X25519 + ML-KEM-768）で共有鍵を作り、HKDF から AES-256-GCM の鍵を導き、画像を暗号化する。封筒（envelope）の形式にバージョンを付ける。運営者の**公開鍵**だけが `apps/upload` に埋め込まれる。秘密鍵は運営者の YubiKey の中だけ（開発・テストではテスト用の鍵ペアを使い、復号は `apps/admin` のローカル復号ツール経由）。
- **審査の差し替え口**：`VerificationProvider` インターフェース（`manual` が今回の実装、将来 SheerID）。
- **付与（Grant）**：本体 DB の `grants` テーブルが唯一の情報源。`resolveEntitlements(owner, at)` が付与から上限を計算し、`DYNAMIC_LIMITS` などの固定値は「付与がないときの既定値」に降格する。
- **状態遷移**：`transitionUsageState(owner, event)` の 1 関数に、年度の切り替え、月初のリセット、付与の期限、手動の停止・凍結を集める。
- **管理画面**：Next.js の別アプリ `apps/admin`。Tailscale のインターフェースだけに bind（`tailscale serve` 経由）。API の `/admin/*` は管理用の別ポートで、運営者のパスキー必須。操作は**消せない記録**（追記専用テーブル + ハッシュ連鎖。Object Lock はフェーズ 6）に残す。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（1.2、1.4、5.1〜5.6、6 章、9.3、9.5、9.8、9.10）

## Global Constraints

- **管理画面はインターネットに公開しない**。開発では `ADMIN_BIND`（既定 `127.0.0.1:3100`）に bind し、`/admin/*` API は `ADMIN_API_PORT`（別ポート）だけで受ける。公開側の API サーバーに `/admin/*` は存在しない（ルート自体を登録しない）。本番の Tailscale 設定は `infra/`（フェーズ 8）で行う。この計画では「Tailscale の IP / `Tailscale-User-Login` ヘッダーを確認するミドルウェア」までを作る。ヘッダーがなければ 404。
- 運営者のアカウントは `operators` テーブル（本体 DB）に登録されたものだけ。運営者のパスキー（`passkeys` を再利用）で**昇格ログイン**（`admin_sessions`、有効 30 分、操作ごとに最終操作時刻を更新）。通常のセッション Cookie では入れない。
- 学生証の画像は**サーバーでも運営者のブラウザでも平文でディスクに残さない**。復号はメモリ上だけ。審査が終わったら**すぐ削除**、7 日で未審査なら自動削除（`purge` ジョブ）。**バックアップに含めない**（個人情報 DB のバックアップ対象から `student_id_blobs` を除外し、テストで固定）。
- 残すのは「承認済み、学校の種類、卒業予定年、有効期限」だけ（`student_verifications` の列）。画像のファイル名・EXIF・メタデータはブラウザ側で落としてから暗号化する。
- 暗号化：X25519 + ML-KEM-768 のハイブリッド、AES-256-GCM、AAD に `{version, uploadId, accountId}` を入れる。ライブラリは固定バージョンで入れる（`@noble/post-quantum`、`@noble/curves`）。独自の暗号は書かない。
- 付与の既定値：Student の有効期限は 3 月 31 日、停止日は 4 月 30 日の翌日（5 月 1 日 0:00 JST）。Starter Grant は 1 人 1 回（`(account_id)` の部分一意索引）。イベントブーストは最大 7 日、開始の 3 日前までに申請。すべての数字は `packages/shared/src/plans.ts` と `platform_settings` テーブルで変えられる。
- Starter Grant の不正対策：メール認証済み、GitHub アカウントの作成日の確認（GitHub OAuth はフェーズ 2 の連携を再利用）、SMS 認証は**プロバイダー差し替え口（`SmsVerifier`）まで**。番号は保存せず HMAC のハッシュだけを重複確認に使う。実際の SMS 送信プロバイダーはフェーズ 8。
- VPN / プロキシ / Tor の検知は「新規登録と学生証の提出で一律ブロック」（9.8）。IP データベースはフェーズ 6 なので、ここでは `NetworkReputation` インターフェースと**ブロックの配線**（`apps/upload` と登録で呼ぶ）、テスト用の固定実装まで。
- 認証が必要な処理は `withAccount`、運営者の処理とワーカーは `withSystem`。新しい本体 DB のテーブルには RLS を付け、`rls.test.ts` に追加する。文言は日英（`packages/i18n`）。自動課金はしない。

## Review Focus

1. **利用者向け API から個人情報 DB に届かない**（接続文字列がない・ロールがない・ネットワークが別）。Task 1 のテストで固定。
2. **サーバー・DB・バックアップを丸ごと盗まれても学生証は読めない**（運営者の秘密鍵なしでは復号できない）。改ざん・別の upload への差し替えを復号が拒否する。Task 2・3 のテストで固定。
3. **審査後すぐ削除・7 日で自動削除・バックアップに入らない**。Task 3・4 のテストで固定。
4. **管理画面は Tailscale 以外から入れない**。公開側 API に `/admin/*` がなく、管理側のポートはヘッダー・IP・昇格ログインの 3 つを満たさないと 404/401。Task 5 のテストで固定。
5. **すべての運営者の操作が追記専用の記録に残り、改ざんが検知できる**。Task 5 のテストで固定。
6. **付与の期限・年度の切り替え・月初・手動の停止が重なっても、状態が矛盾しない**（1 か所の遷移関数）。Task 7 のテストで固定。
7. **Starter Grant は 1 人 1 回**（同時申請でも 1 つ）。イベントブーストの期限が切れると上限が自動で元に戻る。Task 8・9 のテストで固定。

---

### Task 1: 個人情報 DB（分離）

**Files:** `packages/platform/src/pii/{pool,schema}.ts`、`apps/api/drizzle-pii/0000_init.sql`（個人情報 DB 専用のマイグレーションの置き場）、`scripts/dev-up.sh`（`ys-pii-db` を追加）、`apps/api/src/config.ts`（`piiDatabaseUrl` は**ここには置かない**。`apps/admin` と取り込み口の設定にだけ置く）、テスト

- 別コンテナ `ys-pii-db`（PostgreSQL 16、別の Docker ネットワーク `ys-piinet`、ホストにはループバックだけ公開）。ロール `pii_admin`（管理画面用）と `pii_ingest`（暗号文の追記のみ：`INSERT` と自分の行の `SELECT` なし）の 2 つ
- テーブル：`student_id_blobs`（`upload_id`、`account_id`、暗号文 bytea、サイズ、`expires_at`）、`verification_reviews`（審査の記録：担当者、結果、時刻）
- 本体 DB と共有する ID は `account_id` / `upload_id` の UUID だけ。外部キーは張らない（別 DB）
- [ ] テスト：`apps/api` の起動設定・環境変数・コードに `PII_DATABASE_URL` が一切出てこない（設定の網羅テスト）／API のコンテナから `ys-pii-db` に届かない（Docker ネットワーク）／`pii_ingest` は SELECT できない／Review Focus 1

### Task 2: ブラウザ内暗号化ライブラリ

**Files:** `packages/shared/src/idcrypt/{envelope,hybrid-kem,encrypt,decrypt,keys}.ts`、テスト

- `encryptIdImage({ image, recipientPublicKey, uploadId, accountId }) → envelope`（`version`、X25519 の一時公開鍵、ML-KEM の暗号文、nonce、AES-GCM 暗号文）。復号は `decryptIdImage({ envelope, secretKey, uploadId, accountId })`
- 暗号化の前に画像を `canvas` に描き直して EXIF を落とし、最大 3MB の JPEG/WebP にする（HEIC などはブラウザの変換が失敗したらエラー表示）
- 鍵は `generateRecipientKeyPair()`（テスト・開発用）と `parseRecipientPublicKey()`。本番の秘密鍵は YubiKey 内（Task 5 の復号は PIV/PKCS#11 または `age-plugin-yubikey` 相当の外部コマンド呼び出しを `Decryptor` インターフェースで差し替える。この計画では `LocalKeyDecryptor`（テスト用）と `ExternalCommandDecryptor`（YubiKey 用の薄い実装、実機の確認は運営者）まで）
- [ ] テスト：往復／1 バイトの改ざんで失敗／別の `uploadId`・`accountId` で失敗／版が違うと失敗／ブラウザ（Playwright）と Node で同じ封筒が復号できる／封筒に平文の断片が含まれない

### Task 3: 取り込み口と `apps/upload`（学生証の提出専用画面）

**Files:** `apps/upload/`（Next.js の最小構成、`package.json`、`middleware.ts` で CSP と SRI）、`apps/api/src/verification/{submissions,upload-url}.ts`、`apps/api/drizzle/0025_student_verifications.sql`、`apps/api/src/db/schema.ts`、`packages/i18n/src/{ja,en}.ts`

- 本体 DB：`student_verifications`（`id`、`account_id`、`status`: pending / approved / rejected / expired、`school_name`、`school_kind`、`expected_graduation_year`、`valid_until`、`reviewed_at`、`reject_reason`）と `verification_uploads`（`id`、`verification_id`、`blob_ref`、`expires_at`）。RLS（本人だけ）。学生証の画像・暗号文は**本体 DB に入れない**
- `POST /verification/start`（学校名・種類・卒業予定年を受け、`uploadId` と短命の提出トークン（10 分・1 回限り）を返す。**VPN / Tor を検知したら 403**（`NetworkReputation`）。メール認証済みの本人のみ）
- 取り込み口 `POST /ingest/id-upload`（`apps/upload` の専用オリジン宛。`pii_ingest` ロールで暗号文を追記する小さなサーバー。ログに本文・サイズ以外を残さない）
- `apps/upload`：`/[locale]/submit?token=...`。ファイルを選ぶ → ブラウザ内で暗号化 → 送信。**学生証は暗号化前の画像をネットワークに出さない**。CSP は `default-src 'none'` から必要最小限、`script-src` は SRI つきのハッシュのみ、サードパーティなし、`frame-ancestors 'none'`。メールの提出は受け付けない（Web 画面と利用規約の文面に「運営がメールで学生証を求めることはない」を日英で表示）
- 7 日以内に審査されなかった提出は `status = expired`、暗号文を削除し、再提出をお願いするメールを送る（ワーカー、Task 4 の `purge` ジョブに含む）
- [ ] テスト：ネットワークを監視して平文の画像が送られない（Playwright）／期限切れ・使用済みトークンの拒否／他人の `uploadId` への書き込み拒否／CSP と SRI のヘッダーの検証／VPN 検知時の 403／API・ログ・本体 DB の行に画像由来のデータがない／Review Focus 2

### Task 4: 審査の流れと自動削除

**Files:** `packages/platform/src/verification/{provider,manual}.ts`、`apps/api/src/verification/{review,purge}.ts`、`apps/worker/src/worker.ts`（ジョブ登録）、`apps/api/src/scripts/purge.ts`（既存を拡張）、テスト

- `interface VerificationProvider { submit(input): Promise<{ref}>; decide(ref, decision): Promise<void>; status(ref) }`。`ManualProvider` が審査待ちキューを持つ。SheerID は実装しないが、差し替えのテスト用に `FakeProvider` を用意
- 審査ルール（`packages/shared/src/verification-rules.ts`）：3 月の提出は卒業予定年で翌年度の在学を判定、4 月以降は新年度の学生証か在学証明書を要求（承認画面に「新年度のものか」のチェックを表示）
- 承認：`student_verifications.status = approved` + 有効期限 3/31 + **Student の付与**（Task 6 の `grantStudent`）+ 暗号文の**即削除**（同じトランザクション相当：削除に失敗したら承認を確定させない）+ 承認メール。差し戻し：理由を通知、暗号文を削除、再提出できる
- ワーカー `verification-purge`（毎時）：期限切れの暗号文の削除、`pii` の孤児（承認済み・差し戻し済みなのに残っている暗号文）の掃除
- 個人情報 DB のバックアップ設定から `student_id_blobs` を除外（`dev/` の pii バックアップ用スクリプトと、スキーマに「バックアップ対象外」の目印）
- [ ] テスト：承認・差し戻し・期限切れの遷移／承認と暗号文の削除が原子的／削除に失敗したら承認されない／ワーカーが孤児を削除／バックアップ（`pg_dump` 相当）の出力に暗号文が含まれない／Review Focus 3

### Task 5: 管理画面の土台（`apps/admin`・Tailscale 限定・操作記録）

**Files:** `apps/admin/`（Next.js、`package.json`、`middleware.ts`）、`apps/api/src/admin/{server,tailscale,operators,admin-session,audit-log}.ts`、`apps/api/drizzle/0026_operators_audit.sql`、`apps/api/src/db/schema.ts`、`apps/api/src/config.ts`（`adminApiPort`、`adminBind`、`tailscaleRequired`）、`apps/api/src/server.ts`、テスト

- テーブル：`operators`（`account_id`、役割: reviewer / owner、有効か）、`admin_sessions`、`admin_audit_log`（追記専用：`UPDATE`/`DELETE` を禁止するトリガー + 行ごとのハッシュ連鎖 `prev_hash` / `hash`）、`platform_settings`（上限の数字などの設定値）。すべて RLS で `platform_api` からは読めないようにし、管理側のロール `platform_admin` だけが触れる
- 管理側 API は別の `Hono` アプリ（`createAdminApp`）として別ポートで起動する。公開側の `createApp` には**登録しない**（テストで公開側に `/admin/...` が 404）
- Tailscale 判定：リクエスト元が Tailscale の範囲（`100.64.0.0/10` または `fd7a:115c:a1e0::/48`）で、`tailscale serve` が付ける `Tailscale-User-Login` ヘッダーが `operators` と一致すること。開発では `ADMIN_DEV_TAILSCALE=1` で 127.0.0.1 を許可（本番では起動時に無効を強制）
- 昇格ログイン：運営者のパスキーで WebAuthn（フェーズ 1 の `passkeys.ts` を再利用）。YubiKey は `userVerification: required`。30 分で切れる
- 全操作を `audit(operatorId, action, target, detail)` で記録（`withAdmin` ラッパーを通さないと管理側 DB に書けない設計にして、記録の漏れを防ぐ）。画像の閲覧（復号）も記録する
- 危険な操作（全データ削除・本番の鍵の変更など）の「24 時間前に予約」の枠組み（`scheduled_dangerous_actions`）と通知。実際の危険な操作はこの計画では作らず、アカウント凍結の解除だけを例にして枠組みをテストする
- [ ] テスト：ヘッダーなし／Tailscale 以外の IP／運営者でないアカウント／昇格ログインなしの各リクエストが 404/401／公開側に `/admin` なし／記録の `UPDATE`/`DELETE` がトリガーで拒否／ハッシュ連鎖が途切れたら検証関数が失敗を返す／Review Focus 4・5

### Task 6: 付与（Grant）の土台とプランの上限

**Files:** `apps/api/drizzle/0027_grants.sql`、`apps/api/src/db/schema.ts`、`apps/api/src/grants/{grants,entitlements}.ts`、`packages/shared/src/plans.ts`、`apps/api/src/usage/runtime-hours.ts`、`apps/api/src/apps/{apps,databases}.ts`（上限の参照を差し替え）、テスト

- テーブル `grants`：`id`、`target_kind`（account / owner / app）、`target_id`、`kind`（student / starter / event_boost）、`params`（jsonb：上げ幅など）、`starts_at`、`ends_at`、`suspend_on`（停止日）、`reason`、`approved_by`（運営者または `system`）、`revoked_at`。RLS（本人は自分の付与を読める、書き込みはシステムと管理側だけ）。Starter は `(account_id) WHERE kind = 'starter'` の部分一意索引
- `resolveEntitlements(ownerId, at)`：付与なし = 「なし」プラン（アプリは動かせない）、Student = スペック 5.2 の値、Starter = Pro 相当（Pro の中身はフェーズ 7 なので、この計画では **Student と同じ値 + 動的アプリ数 2** を仮の値として `STARTER_LIMITS` に置き、フェーズ 7 で更新と明記）、イベントブースト = 期間中の上乗せ。`STATIC_LIMITS` / `DYNAMIC_LIMITS` / `DATABASE_LIMITS` の参照は `resolveEntitlements` 経由に置き換える（既定値は付与がないときの「なし」ではなく、既存テストが通るよう **開発用の `ENTITLEMENTS_MODE=legacy` を設けず**、既存のテストのフィクスチャが Student の付与を作るようにする）
- `grantStudent(accountId, validUntil)`（3/31 と 5/1 の計算は `packages/shared` の日付ヘルパー、JST）
- `platform_settings` で上限の数字を上書きできる（管理画面から、Task 5 の記録つき）
- [ ] テスト：付与なしで動的アプリの起動と DB 作成が拒否される／Student で既存の挙動と同じ／期限切れで「なし」に戻る／既存の `apps` `databases` `runtime-hours` のテストがフィクスチャの更新だけで通る／設定の上書き

### Task 7: 利用の状態遷移（1 か所）

**Files:** `apps/api/src/usage/state.ts`、`apps/api/drizzle/0028_usage_state.sql`、`apps/worker/src/worker.ts`（遷移のジョブ）、既存の `runtime-hours.ts` `transfer.ts` の停止・再開の呼び出し口、テスト

- 状態：`active` / `grace`（猶予中）/ `suspended`（停止中）/ `blocked`（ブロック中）/ `frozen`（凍結）。`usage_states` テーブル（owner ごと、現在の状態と理由、次に評価する日時）
- `transitionUsageState(ownerId, event)` の 1 関数だけが状態を変える。イベント：`fiscal_year_rollover`（3/31 → 4/1 に猶予、5/1 に停止）、`month_start_reset`、`grant_expired`、`grant_revoked`、`reregistered`、`manual_block` / `manual_unblock`、`manual_freeze` / `manual_unfreeze`、`pro_started`（フェーズ 7 の予約）。優先順位は「凍結 > ブロック > 停止 > 猶予 > 有効」で、解除しても上位の別の理由が残っていれば戻らない（理由は集合で持つ）
- 「認証の有効期限（3/31）」と「停止する日（5/1）」は別々の列
- 停止の実体（コンテナを 0 に、DB は残す）と再開は既存の `sleep` / `wake` / `stop` の口を使う。データ・イメージは削除しない
- 3 月 1 日の「翌年度の再登録の受付」開始と、卒業予定年を過ぎた人への案内メール（日英）
- [ ] テスト：全イベントの組み合わせ表（表形式で網羅）／同じ日に年度の切り替え + 月初 + 付与の期限が重なっても同じ結果／上位の理由が残る間は解除されない／5/1 に再登録していない無料アプリだけが止まる／再登録で再開／Review Focus 6

### Task 8: Starter Grant（申請・審査・終了）

**Files:** `apps/api/src/grants/starter.ts`、`apps/api/src/verification/{github-age,sms}.ts`、`apps/api/drizzle/0029_starter_applications.sql`、`apps/web/app/[locale]/starter/`、テスト

- 申請フォーム（作りたいもの、GitHub アカウント、自己紹介）。メール認証済み・GitHub 連携済みで、アカウントの作成日が閾値（`platform_settings`、既定 90 日）以上であること。必要なら `SmsVerifier` で認証し、番号の HMAC ハッシュだけを `sms_hashes` に保存して重複を拒否
- 管理画面（Task 10）で承認し、運営者が**期間を決める**。承認は 1 人 1 回（部分一意索引 + 同時申請のテスト）
- 終了の 14 日前と 3 日前に通知（メール・画面。重複して送らない）。終了後は自動課金せず、申し込みがなければ停止（Task 7 の `grant_expired`）。データは残す
- [ ] テスト：1 人 1 回（同時申請含む）／GitHub の作成日が新しいと拒否／番号のハッシュの重複を拒否し、平文の番号がどこにも残らない／14 日前・3 日前の通知が 1 回ずつ／終了後の停止と、データが残ること／Review Focus 7

### Task 9: イベントブースト

**Files:** `apps/api/src/grants/event-boost.ts`、`apps/api/drizzle/0030_event_boosts.sql`、`apps/web/app/[locale]/apps/[name]/boost/`、`apps/api/src/apps/{wake,apps}.ts`、`apps/api/src/usage/transfer.ts`、テスト

- 利用者が申請（イベント名、日付 最大 7 日、予想アクセス数）。開始の 3 日前までに申請。運営者が承認し、上げ幅（転送量・メモリ）を調整する
- 期間中（`resolveEntitlements` が付与から計算）：転送量の上限を引き上げ、スリープをオフにし（`sleepAfterMinutes = null`）、メモリを増やす。異常検知の急増基準を緩める値は `anomaly_threshold_multiplier` として公開し、**使うのはフェーズ 6**（この計画では値の受け渡しまで）
- 使った稼働時間は月・年の上限に数える。期間が終わったら自動で元に戻る（ワーカーが終了時にコンテナを再作成してメモリを戻し、スリープを再開）
- [ ] テスト：3 日前を過ぎた申請の拒否／7 日を超える申請の拒否／期間中の上限・スリープ・メモリ／終了後の復帰（時計を進めて確認）／稼働時間が月・年に数えられること／Review Focus 7

### Task 10: 管理画面の機能（審査・付与・利用者・設定）

**Files:** `apps/admin/app/(ops)/{reviews,grants,accounts,settings,audit}/`、`apps/api/src/admin/{reviews,grants,accounts,settings}.ts`、`apps/admin/lib/decrypt-viewer.ts`、`packages/i18n`（管理画面は日本語のみで可。英語は不要と明記）、テスト、`apps/admin/e2e/`

- **審査**：審査待ちの一覧 → 1 件を開く → ローカル復号ツール（`Decryptor`）で画像をメモリ上に出して表示 → 承認 / 差し戻し（理由）。画像はダウンロード・右クリック保存を無効にし、画面を閉じる・30 秒操作がないと破棄。閲覧のたびに記録
- **付与**：Student の手動付与・取り消し、Starter の承認（期間の設定）、イベントブーストの承認（上げ幅の調整）、付与の一覧と履歴
- **利用者**：アカウント検索（メールは完全一致の照合だけ。表示時のみ復号して記録）、状態の確認、ブロック / 停止 / 凍結とその解除（Task 7 の遷移経由）
- **設定**：上限の数字（`platform_settings`）の編集。変更前後を記録
- **記録**：`admin_audit_log` の閲覧とハッシュ連鎖の検証ボタン
- [ ] E2E（Playwright、開発用の運営者）：学生証の提出（`apps/upload`）→ 審査待ちに出る → 復号して承認 → 利用者側でプランが Student になり動的アプリを作れる → 暗号文が削除されている／差し戻し → 再提出 → 承認／Starter 申請 → 承認 → 終了の通知／ブースト申請 → 承認 → 期間中だけ上限が上がる／運営者でないアカウントは管理画面に入れない

### Task 11: 利用者向け Web 画面とドキュメント

**Files:** `apps/web/app/[locale]/{plan,verify}/`、`apps/web/components/`、`packages/i18n/src/{ja,en}.ts`、`README.md`、`dev/`

- 「プラン」画面：現在のプラン（なし / Student / Starter）、付与の期限・停止日、年間スケジュール、Starter / ブーストの申請への導線
- 「学生審査」画面：提出の状況（審査待ち / 承認 / 差し戻し + 理由）、`apps/upload` への導線（提出は別オリジン）。学生証はブラウザ内で暗号化されることと、メールで求めないことを日英で説明
- 上限に近づいたときの 80% 通知のメールと画面に、付与の種類に応じた案内を追加
- README に管理画面の起動方法（`pnpm dev` に `admin` と `upload` を追加、`ADMIN_DEV_TAILSCALE`）と、運営者の登録手順（`apps/api/src/scripts/add-operator.ts`）を書く
- [ ] E2E：Student の承認後に画面のプランが切り替わる／差し戻しの理由が表示される。`pnpm lint` `pnpm typecheck` `pnpm test` と E2E が全部通ること

---

## フェーズ 5 でやらないこと

- Tailscale 自体の設置・ACL・本番の公開範囲（フェーズ 8 の `infra/`）。YubiKey 実機での復号の確認は運営者が行う（`ExternalCommandDecryptor` の手順を README に書くところまで）
- VPN / Tor / IP 情報データベースの本実装（`NetworkReputation` の配線のみ。実データはフェーズ 6）、Object Lock での消せない記録（追記専用 + ハッシュ連鎖まで。Object Lock はフェーズ 6）
- 実際の SMS 送信プロバイダー、SheerID 連携（差し替え口まで）
- Pro の値段と中身、保護者の同意、自動課金（フェーズ 7）。`pro_started` イベントは予約のみ
- 異常検知の基準の緩和そのもの（値の受け渡しまで。フェーズ 6）
- 長く使われていないアカウントの扱い、データの持ち出し（フェーズ 5〜7 のうちフェーズ 7 で決める）
