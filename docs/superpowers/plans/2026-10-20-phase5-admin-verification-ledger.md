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

### Task 3: 取り込み口と `apps/upload` — 実装済み（未コミット）
- 本体 DB: `0025_student_verifications.sql`（`student_verifications`・`verification_uploads`、RLS：本人だけ読める／pending の間だけ作成・更新、承認系の列と提出トークンの消費はシステム側だけ）。画像・暗号文の列はなし。提出トークンは `<uploadId>.<accountId>.<秘密>`（10 分・1 回限り、DB にはハッシュのみ）。
- API: `POST /verification/start`（Cookie セッション必須、`NetworkReputation` で VPN/Tor は 403、1 時間 10 回）、取り込み口専用の `POST /internal/verification/consume-token`（`INGEST_SHARED_SECRET` が設定されたときだけ存在、ヘッダー不一致は 404）。`shared` に `verification.ts`・`network-reputation.ts`（固定実装つき）、i18n に日英の文言。
- 取り込み口: ロジックは `platform/pii/ingest.ts`（`handleIdUpload`）。`pii_ingest` で追記のみ、ID はトークン由来だけ、ログはイベント・状態・サイズだけ。**`apps/api` には PII の文字列を一切置かない**（`pii-isolation` テストが通る）。
- `apps/upload`: **Next.js ではなく素の Node サーバー + esbuild の 1 本のバンドル**にした（計画からの変更）。Next の起動用インラインスクリプトは内容が毎回変わりハッシュ固定にできず、`script-src` を SRI のハッシュだけにできないため。CSP は `default-src 'none'`・`script-src` はバンドルの sha384 のみ・`frame-ancestors 'none'`、サードパーティなし（`src/security-headers.ts` が計画の `middleware.ts` に相当）。トークンはアドレスバーから即消す。
- 検証: Playwright（`pnpm --filter upload e2e`、実 Chromium）で、送信は封筒の POST 1 回のみ・同一オリジン・平文の断片なし・Node で復号できることを確認（**Task 2 で未実施だったブラウザ⇔Node の相互復号もここで完了**）。CSP 違反の警告もなし。
- 配線メモ: `apps/upload` の `node_modules` は pnpm install をせず、既存パッケージへのリンクを手で作成し `pnpm-lock.yaml` に importer を追記（`--frozen-lockfile` 検証済み、新規パッケージなし）。クリーン環境では `pnpm install` で同じ状態になる。`.env.development(.example)` に `UPLOAD_ORIGIN`・`INGEST_SHARED_SECRET`（開発用ダミー）を追加。`ID_RECIPIENT_PUBLIC_KEY` は `pnpm --filter upload keygen` で作る。
- 未実施・持ち越し: 実際の API ⇔ 取り込み口 ⇔ 個人情報 DB を通した結合は未確認（各部分は個別テスト済み）。トークン消費後に PII への書き込みが失敗した場合は再度「提出を始める」必要があり、残った `verification_uploads` は Task 4 の `purge` で掃除する。7 日での `expired` 化・暗号文削除・再提出メールは Task 4。ルートの `dev` スクリプトには `upload` を追加していない。

### Task 4: 審査の流れと自動削除 — 実装済み（未コミット）
- 追加: `platform/verification/{provider,manual}.ts`（`VerificationProvider`、`ManualProvider` が審査待ちキュー、`FakeProvider` は決定を記録する差し替え確認用）、`shared/verification-rules.ts`（JST。1〜2 月は今年度、3 月は卒業予定年で翌年度の在学を判定、4 月以降は新年度の書類の確認を要求。有効期限は 3/31、3 月以降の承認は翌年の 3/31）。
- `apps/api/src/verification/review.ts`（`approveVerification` / `rejectVerification` / `listPendingReviews`）：承認 = `approved` + 有効期限 + `grantStudent` + 暗号文の削除を 1 トランザクション。削除は最後に行い、失敗または暗号文なしなら例外で全体を巻き戻す（承認されない・付与もメールもなし）。削除後にコミットが失敗した場合も、残るのは「暗号文なしで審査待ち」で画像は残らない。差し戻しは理由をメールし暗号文を削除、再提出可。
- **`grantStudent` は Task 6 が未実装のため注入式**（`GrantStudent = (tx, accountId, validUntil) => Promise<void>`）。Task 6 で本物を渡す。呼び出し元（管理画面 API）は Task 5/10。
- `purge.ts`：期限切れ（提出から 7 日）→ `expired` + 暗号文削除 + 再提出メール（削除に失敗したら expired にせず次回再試行）、孤児の暗号文（決定済み／本体 DB に行なし（1 時間の猶予）／暗号文自身の期限切れ）の掃除、未使用トークン行の削除。`scripts/purge.ts` には未使用トークンの掃除だけ追加（apps/api は個人情報 DB に接続しないため暗号文は触れない）。
- apps/api は個人情報 DB を知らない構成を維持：削除側は `IdBlobStore` インターフェース（`api/verification/blob-store.ts`）を注入、実体は `platform/pii/store.ts` の `createIdBlobStore`（`pii_admin` 接続、審査の記録の追記と暗号文の削除は同一トランザクション）。`pii-isolation` テストは通る。
- ワーカー：ジョブ `verification.purge`（`JOBS.verificationPurge`）を毎時 0 分に `boss.schedule`。`PII_ADMIN_DATABASE_URL` が無ければ警告して無効（`apps/worker` の起動スクリプトが `.env.pii.development` も読む）。
- バックアップ除外：`drizzle-pii/0001_backup_exclude.sql` で `student_id_blobs` に `COMMENT 'backup:exclude'`、`PII_BACKUP_EXCLUDED_TABLES`、`dev/pii-backup.sh`（目印のあるテーブルは `--exclude-table-data`）。実物の pg_dump 出力に暗号文が含まれないことをテストで確認（コンテナ内の pg_dump を使用）。**既存の dev DB には `pnpm --filter platform pii:migrate` が必要**。
- テスト: `shared/test/verification-rules`、`platform/test/{pii/store,verification-provider}`、`api/test/verification-review`（メモリ上のストア、遷移・原子性・期限切れ・孤児）、`worker/test/verification`（本体 DB + 個人情報 DB の実物で、提出 → 承認／差し戻し／削除失敗（権限を外して再現）／ワーカーのジョブ）。
- 持ち越し: 承認・差し戻しを呼ぶ管理画面の API と、画像の復号表示は Task 5/10。`SMS` 等は対象外。

### Task 5: 管理画面の土台 — 実装済み（未コミット）
- DB: `0026_operators_audit.sql`（`operators`・`admin_sessions`・`admin_audit_log`・`platform_settings`・`scheduled_dangerous_actions`）。全表 FORCE RLS、`platform_api` の権限を REVOKE（読めない）、ロール `platform_admin` だけが policy 経由で触れる。記録は BEFORE INSERT トリガーが `seq`/`prev_hash`/`hash` を決める（advisory lock で直列化）、UPDATE/DELETE/TRUNCATE はトリガーで拒否（所有者ロールも）、`admin_audit_verify()` が最初に食い違った seq を返す。`operators` に `tailscale_login` 列を追加（計画に無いが Tailscale-User-Login の照合に必要）。
- API: `apps/api/src/admin/{server,tailscale,operators,admin-session,audit-log,dangerous}.ts`。`createAdminApp` は別ポート（`adminApiPort` 3002、`adminBind`）で `server.ts` から起動、公開側 `createApp` には登録せず import もしない（テストで固定）。ゲート順：接続元が 100.64.0.0/10 か fd7a:115c:a1e0::/48 → `Tailscale-User-Login` が有効な運営者と一致 → いずれも失敗は素の 404。昇格ログイン（`/admin/session/start|finish`）は `startPasskeyLogin`/`finishPasskeyLogin`（userVerification: required）を再利用し、運営者自身のパスキーでなければ 401、30 分の絶対期限（延長なし）、トークンはハッシュ保存、運営者の無効化は即時反映。
- `withAdmin(db, operator, {action,target,detail}, fn)`：`platform_admin` に切り替え + `app.operator_id` 設定 + **先に記録** + 処理を 1 トランザクションで。policy が「いまの運営者名義の記録／設定／予約」しか書けないようにしてあるので、これを通さない書き込みは DB が拒否。閲覧（一覧・検証）も記録。
- 設定：`tailscaleRequired`・`adminDevTailscale`（`ADMIN_DEV_TAILSCALE=1` で 127.0.0.1/::1 を許可）。`NODE_ENV=production` で両緩和のどちらかが入っていると起動時に例外。Tailscale 自体は導入せず、テストは偽ソケット（`remoteAddress`）で再現。
- 危険な操作：`scheduleDangerous`（24 時間後、owner のみ、登録済みアクションのみ、全 owner にメール）／`cancelDangerous`／`runDueDangerous`（条件付き UPDATE で 1 回だけ、ハンドラ失敗なら scheduled のまま）。例は `unfreeze_account`（本物の凍結状態は Task 7。いまは `platform_settings` に印を付けるだけ）。`runDueDangerous` を回すワーカーのジョブは**未配線**（Task 7/10 で）。
- 他：`PUT /admin/settings/:key`（owner、変更前後を記録。上限の上書きの読み出しは Task 6）、`GET /admin/audit[/verify]`。
- `apps/admin`：Next.js ではなく素の Node の殻（`src/server.ts`、CSP `script-src 'self'`、noindex、no-store。API は中継せず `tailscale serve` のパス指定で同一ホストに載せる。中継すると接続元が tailnet でなくなるため）。ログイン画面と機能画面は Task 10。
- **要対応（オフラインのため未実施）**：`apps/admin` は新しい workspace パッケージ。`pnpm-lock.yaml` の importer と `node_modules` のリンクはオンラインの `pnpm install`（新規パッケージなし、既存と同じバージョン）が必要。それまで `tsconfig.json` の `typeRoots` で `apps/api` の `@types/node` を借りており、`tsc`/`eslint`/`vitest` はルートの bin で動く（`dev`/`start` の `tsx` は install 後）。install 後は `typeRoots` の借用行は削除可。
- テスト：`apps/api/test/admin.test.ts`（19 件：Tailscale 範囲、各種 404/401、公開側に /admin なし、記録の不変性・ハッシュ連鎖・改ざん検知、権限分離、昇格ログイン、設定、危険な操作）、`apps/admin/test/shell.test.ts`。api 244 件全通過。`pnpm -r typecheck` / `pnpm -r lint` 通過。
- 持ち越し：同時追記時の連鎖の整合は advisory lock の設計で担保したが、複数接続での負荷テストは未実施（テスト DB が 1 接続）。`add-operator.ts` は Task 11。画像閲覧（復号）の記録は `withAdmin` を通すだけで Task 10 で使う。

### Task 6: 付与の土台とプランの上限 — 実装済み（未コミット）
- DB: `0027_grants.sql`（`grants`：RLS で本人は自分宛て（アカウント／見えるオーナー／見えるアプリ）だけ読め、`platform_api` は SELECT のみ。書くのは owner ロールと管理側 `platform_admin`）。Starter は `target_id` の部分一意索引（取り消し後も再付与しない）、Student は同じ対象に有効なものを 1 つだけ（再登録は期限の更新）。
- `shared`: `plans.ts` に `buildEntitlements`（純粋関数）・`STARTER_LIMITS`（**仮：Student と同じ + 動的アプリ 2。フェーズ 7 で更新**）・`NO_PLAN_DYNAMIC_LIMITS`・`LIMIT_SETTING_KEYS`、`fiscal-dates.ts`（JST の 3/31・5/1、`suspendDateFor`）。`STATIC/DYNAMIC/DATABASE_LIMITS` の値は Student の値としてそのまま。
- `api/grants/{grants,entitlements}.ts`：`resolveEntitlements(db, ownerId, at)`（付与なし = 「なし」、期限 `ends_at` は最後の瞬間を含む、取り消し・期限切れで「なし」に戻る）、`grantStudent(tx, accountId, validUntil, {approvedBy})`、`revokeGrant`。個人オーナー = そのアカウントの付与、**チームオーナー = チームの owner ロールのメンバーの付与を引き継ぐ**（設計判断）。event_boost は `extraTransferBytes` / `extraMemoryMb` / `sleepOff` を期間中だけ上乗せ（運用・承認は Task 9）。
- 上限の参照の置き換え：`createApp`（動的は付与なしで `plan_required`、動的の数は `appsPerOwner`、総数は従来どおり静的の上限が基準）、`addDatabase`/`getDatabase`（付与なしで `plan_required`、サイズ・接続数・メモリはプランから）、`runtime-hours`（月／年の時間をオーナーのプランから。付与なし = 0 時間 = 期間の終わりまでブロック）、`database-watch`（オーナーごとのサイズ。付与が切れても Student のサイズで見て、DB を勝手にブロックしない = 停止は Task 7）。HTTP は `plan_required` を 403。
- `platform_settings` の上書き：`limits.<static|dynamic|database>.<名前>` の既知キーで、0 以上の数だけ有効（不正な値・未知のキーは無視）。Admin の `PUT /admin/settings/:key` は `limits.*` の不正なキー・値を 400 で拒否（記録は Task 5 のまま）。「なし」の動的は上書きしても 0。
- Task 4 の配線：`approveVerification` の `grantStudent` は省略すると本物（承認と同一トランザクション、`approved_by` = 運営者）。削除に失敗したら付与も巻き戻ることをテストで確認。
- フィクスチャ：`test/helpers/grants.ts` の `giveStudent`（2020〜2100 年）を動的アプリを作る既存テストの `setup` に追加しただけ（assert の変更なし）。`admin.test.ts` の設定テストは実在の `limits.dynamic.appsPerOwner` に合わせ、拒否の 2 件を追加。
- `apps/admin/tsconfig.json` の `typeRoots` 借用を削除（`pnpm install` 済みで自前の `@types/node` を使う）。
- テスト：`api/test/grants.test.ts`（6 件）+ `verification-review` に 1 件。api 251 / static 35 / shared 45 / worker 5 / admin 2 全通過、`pnpm -r typecheck` / `lint` 通過。
- 持ち越し：静的サイトの転送量上限（`transfer.ts`）・実行時のメモリ／CPU（`deployments.ts`）・ビルド上限（`ingest/dynamic.ts`）・スリープ時間（`wake.ts`）はまだ定数のまま（`resolveEntitlements` には値がある。ブーストの反映は Task 9）。付与切れの扱い（停止・猶予）は Task 7。付与を操作する管理画面 API は Task 10。実行ブロックの理由は `runtime_limit` のまま（「なし」でも同じ）。
