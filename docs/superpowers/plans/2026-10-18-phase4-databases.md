# フェーズ 4（利用者向けデータベース）実装計画

**Goal:** 動的アプリごとに PostgreSQL を 1 つ持てるようにする。画面の「DB を追加」で作られ、`DATABASE_URL` が自動でアプリに渡る。アプリごとに別の DB・別のユーザーで、そのアプリからしかつながらない。容量は 256MB（80% で通知、100% で書き込みだけ停止）、接続は 10 まで。自動バックアップから利用者が自分で戻せる。

**Architecture:** `DatabaseDriver` インターフェースで抽象化する（フェーズ 3 の `RuntimeDriver` と同じ考え方）。

- **Docker ドライバ**（開発・テスト用、実際に動かす）：アプリごとに PostgreSQL のコンテナ `ys-db-<appId>` を作り、アプリ専用の内部ネットワーク `ys-dbnet-<appId 先頭 12 文字>`（`internal: true`、外へ出られない）に置く。アプリのコンテナもそのネットワークに参加させる。ほかのアプリはこのネットワークに入れないので届かない。バックアップは `pg_dump` を定期的に取ってストレージ（MinIO）に置き、戻すときはその時点のダンプから作り直す。
- **Kubernetes ドライバ**（本番用）：CloudNativePG の `Cluster` を持ち主の名前空間に作る（容量・接続数・バックアップ先・保持 7 日）。NetworkPolicy でそのアプリの Pod からだけ受け付ける。戻すときは `bootstrap.recovery`（時刻指定）で新しいクラスタを作って切り替える。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（4 章、5.2）

## Global Constraints

- 初期値（`packages/shared/src/plans.ts` の `DATABASE_LIMITS`）：**DB は動的アプリ 1 つにつき 1 つ、256MB、接続 10、80% で通知、100% で書き込み停止、バックアップの保持 7 日**。開発の Docker ドライバでは 1 時間ごとに論理バックアップを取る。
- 作る DB のユーザーはスーパーユーザーではない。`CREATE ROLE app_<短い ID> LOGIN CONNECTION LIMIT 10`、その DB の持ち主にする。パスワードはランダム 32 バイト、`APP_ENV_KEY` で暗号化して本体 DB に保存（環境変数と同じ扱い）。画面・API で再表示しない。
- `DATABASE_URL` は DB があるときプラットフォームの値で上書きする（利用者が同じ名前の環境変数を設定していても）。画面にそう書く。
- 容量の確認はワーカーが 5 分ごと（`pg_database_size`）。100% で `ALTER DATABASE ... SET default_transaction_read_only = on` と既存の接続の切断、80% 未満に戻ったら解除。メールは 80% と 100% で 1 回ずつ（同じ月に何度も送らない）。
- DB の削除はアプリの削除・DB の削除操作で行う。削除前に最後のバックアップを取り、7 日間は残す（誤削除からの復旧用）。
- 外部からの接続は CLI の一時的なトンネルだけ（Task 7）。DB のポートはホストにもインターネットにも公開しない。
- 認証が必要な処理は `withAccount`（アプリを管理できる人だけ）、ワーカーは `withSystem`。新しいテーブルには RLS。文言は日英。

## Review Focus

1. **ほかのアプリから DB に届かない**（Docker：別ネットワーク、Kubernetes：NetworkPolicy）。Task 1・6 のテストで固定。
2. **容量 100% で書き込みが止まり、読み取りは続く。消して 80% 未満に戻ると書けるようになる**。Task 3 のテストで固定。
3. **戻す操作の途中で失敗しても、元の DB が残る**（新しく作ってから切り替える）。Task 4 のテストで固定。
4. **パスワードが画面・API・ログ・ビルドログに出ない**。Task 2 のテストで固定。
5. **同時に「DB を追加」を 2 回押しても 1 つしか作られない**（`(app_id)` の一意制約）。Task 2 のテストで固定。

---

### Task 1: DatabaseDriver と Docker ドライバ

**Files:** `packages/platform/src/database/{driver,docker}.ts`、テスト

- `interface DatabaseDriver { create(spec): Promise<void>; remove(appId): Promise<void>; status(appId); connectionFor(appId): { host, port, network? }; sizeBytes(appId); setReadOnly(appId, on); backup(appId): Promise<Readable>; restore(appId, dump: Readable): Promise<void> }`
- Docker：`postgres:16-alpine`、メモリ 256MB 程度、`--network ys-dbnet-*`（internal）、ホストにポートを公開しない。初期化で役割と DB を作り、`CONNECTION LIMIT 10`、`public` スキーマの権限を整える
- `DockerDriver`（アプリ側）：DB があるアプリのコンテナを `ys-dbnet-*` にも接続する
- [ ] テスト：作成 → アプリ役のコンテナから接続できる／別アプリ役のコンテナからは届かない、容量の取得、読み取り専用の切り替え、バックアップと復元、削除

### Task 2: 本体 DB・API・`DATABASE_URL` の受け渡し

- テーブル `app_databases`（app_id 一意、状態、暗号化した資格情報、容量、読み取り専用か、通知済みの段階）と RLS
- `POST/DELETE /apps/:id/database`、`GET /apps/:id/database`（状態・容量・上限、パスワードは返さない）
- `buildRunSpec` で `DATABASE_URL` を付ける。アプリの削除で DB も削除
- [ ] テスト：権限、二重作成、パスワードが応答に出ない、`DATABASE_URL` がアプリに渡る

### Task 3: 容量の見張り

- ワーカーで 5 分ごとに全 DB の容量を測り、80% で通知、100% で読み取り専用、戻れば解除
- [ ] テスト：Review Focus 2

### Task 4: バックアップと戻す操作

- 1 時間ごとのバックアップ（Docker）、7 日より古いものを削除、一覧と「この時点に戻す」
- 戻すときは新しい DB を作ってデータを入れ、成功してから切り替える
- [ ] テスト：Review Focus 3

### Task 5: Web 画面

- 動的アプリの画面に「データベース」：追加・削除・容量の棒グラフ・読み取り専用の表示・バックアップの一覧と戻す操作（日英、専門用語をかみくだく）

### Task 6: Kubernetes ドライバ（CloudNativePG）

- マニフェスト（`Cluster`、バックアップ先、保持 7 日、容量、NetworkPolicy、資格情報の Secret）と適用。戻すのは時刻指定の `bootstrap.recovery`
- [ ] モックでのテストとマニフェストのスナップショット。k3d に CloudNativePG を入れて実際に試す（オペレーターの取得には利用者の許可を得る）

### Task 7: CLI のトンネル

- `yourservice db connect <アプリ名>`：API の WebSocket 経由で手元の `localhost:<port>` に一時的に DB をつなぐ（有効期限つき・アプリの持ち主だけ）

---

## フェーズ 4 でやらないこと

- 保存データの暗号化（ディスク・バックアップの暗号化は本番インフラ、フェーズ 8）
- 予備への自動切り替えの本番構成（CloudNativePG の 2 台構成はフェーズ 8。開発は 1 台）
- プランごとの容量の違い（フェーズ 5）
