# フェーズ 6（城壁）実装計画

**Goal:** 異常の検知から、アプリへのアクセスの遮断、必要なコンテナの停止、利用者と運営者への通知、異議申し立て、運営者の解除・停止継続・凍結までをつなぐ。Falco、CPU・外向き通信、公開時のフィッシング判定、ファイル配布の検知、ハニートークン、VPN 判定を共通の事件記録に集め、運営操作と自動対処の記録を Object Lock に保存する。

**Architecture:**

- **検知と対処を分離**：検知器は正規化した `SecuritySignal` を出す。新設の `apps/api/src/security/` が事件・ブロック理由・副作用の再試行を管理する。高 = アプリ遮断 + コンテナ停止、中 = アプリ遮断、低 = 運営通知。IP、アプリ、アカウントの対象を混同しない。
- **既存の状態遷移を拡張**：アプリ単位の遮断理由は新しい表で管理する。アカウント全体の凍結は既存 `transitionUsageState` と `shared/usage-state.ts` だけを通す。既存のオーナー単位の `manual_block` をアプリ単位の自動ブロックに流用しない。
- **遮断する場所**：現在の `dev/k8s/edge.yaml` は Traefik → `apps/static`（静的配信と動的プロキシ）の構成。共通の判定を Traefik の認証判定口と `createStaticApp` の HTTP / WebSocket に接続し、起動・ロールバック・再デプロイでも迂回できなくする。
- **差し替え可能な入力**：Falco、CPU、外向き通信、Safe Browsing、IP 情報はアダプターで注入する。日常の自動テストは固定 JSON、偽時計、偽ドライバー、偽 S3、ローカルの使い捨て PostgreSQL で完結する。
- **消せない記録**：Phase 5 の `withAdmin` / `auditedSystem` / `verifyAuditChain` と `0026_operators_audit.sql` の連鎖を維持し、自動対処には別のシステム用監査連鎖を作る。DB への追記と配送待ちを同一トランザクションで確定し、専用の Object Lock 保管先へ連続した範囲を配送・検証する。一般の `Storage.sites` / `sources` と削除 API を共有しない。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（0.1〜0.3、1.1〜1.5、2.1〜2.5、3.1〜3.6、4 章、5.1〜5.6、6.1〜6.3、7 章、8 章、9.1〜9.10、10〜13 章）。依存確認では全 613 行を対象とする。実装済みの基準は `docs/superpowers/plans/2026-10-20-phase5-admin-verification-ledger.md`（Tasks 1〜11、末尾の Chromium E2E 確認を含む）。

## Global Constraints

- この文書は計画のみ。実装・インストール・データ取得・サービス停止・SSH・デプロイ・コミットを実行しない。実装時は対象アプリを停止してからコードを書き換える。既存の個人情報 DB 分離、暗号化、審査後の削除、管理画面の Tailscale・昇格ログインを維持する。
- **導入承認が必要な手順**を各 Task に明示する。Falco 本体・ルール・ドライバー・コンテナ画像、IP データと Tor / 例外リスト、DB 監査拡張と収集器、外向きプロキシはダウンロード前に種類・固定バージョンまたは digest・配布元・必要権限・ライセンス・更新方法を提示して承認を得る。追加 npm パッケージは既定では不要。MMDB 読み取りなどで採用する場合は名前・固定バージョン・lockfile 差分を提示し、承認後だけ追加する。
- **外部設定の承認**はソフト導入と別：Safe Browsing の利用条件・資格情報・URL 送信範囲、IP データの契約、Object Lock の保管先・保持期間・料金・IAM を確定してから有効化する。未確定のまま購入・外部送信・解除不能な保持を設定しない。キーの平文をチャットや Git に置かない。
- 管理操作は `withAdmin` / `auditedSystem`、本人の閲覧は `withAccount`、内部処理は `withSystem`。新テーブルは FORCE RLS と最小権限。検知の取り込み口は公開 API・管理 API と別の内部リスナーにし、送信元認証・リプレイ拒否・サイズ制限を必須とする。送信者が指定した app / owner を信用せず、実際の workload と照合する。
- **即座の遮断**は事件・有効なブロック理由の DB commit 後、次の判定から適用する（判定結果の許可キャッシュは置かない）。停止・通知・Object Lock 配送は耐久 outbox で再試行する。判定不能時は対象経路を 503、根拠のない恒久ブロックや自動凍結はしない。過去に許可した WebSocket・長時間応答の切断も Task 2 に含む。
- 月初・付与・イベント終了・再提出・再デプロイでセキュリティ理由を外さない。解除は対象の理由だけ。データ・DB・イメージは削除しない。アカウント凍結の解除は既存 `scheduled_dangerous_actions` の 24 時間予約を維持する。
- 本文・環境変数・認証情報・学生証・生年月日・生の IP・クエリ付き URL を事件や WORM に保存しない。IP ブロックの検索は秘密鍵による HMAC（IPv4 / IPv6 正規化後）、表示は既存 `maskIp`。永続監査は匿名の事件 ID・操作・時刻・理由コード・ハッシュに限定し、アカウントとの対応は削除可能な DB 側だけに置く。通常のアクセスログは既存の 30 日削除を維持し、Object Lock に転載しない。
- 学校・iCloud Private Relay の例外は VPN 判定の前に適用するが、罠・攻撃・アプリ遮断の免除にはしない。閲覧・変更は VPN だけでは止めない。例外も信頼されたデータ・運営者の記録付き設定からのみ作る。
- 開発は localhost。実運用の管理リンクは Tailscale 内の設定済み URL を使う。テストは実 Falco、クラウド、Google、MaxMind / IPinfo、Tor、SMTP、外部 DNS を必要としない。ローカル DB 等の既存イメージも自動取得しない。不足ソフトのテスト準備は承認待ちとして明示し、通過扱いにしない。

## Review Focus

1. **被害範囲に応じた対処**：高・中・低と IP / アプリ / アカウントの範囲が正しく、他人のアプリや DB を止めない。Task 1・2・9。
2. **遮断の迂回がない**：静的・動的・全 HTTP メソッド・WebSocket・既存接続・再起動・ロールバックに効き、停止失敗でも遮断は残る。Task 2・3。
3. **検知器の誤判定と偽装に耐える**：信頼した送信者と workload の照合、重複・遅延・欠損、ブースト境界、例外、未知判定を扱う。Task 3〜7。
4. **罠は権限・個人情報を持たず確実に検知できる**：全 7 種類に配置と検知経路があり、実管理画面や利用者サイトを公開しない。Task 7。
5. **記録の改ざん・末尾切り捨ても検知できる**：連鎖だけでなく外部 checkpoint と Object Lock の版・保持を検証し、配送不能を見落とさない。Task 8。
6. **運営者の復旧が安全**：通知と異議申し立てが残り、解除は別理由を保ち、凍結解除の予約を迂回しない。Task 9・10。
7. **外部サービスなしで再現できる**：拒否・再試行・競合を自動テストし、承認後の実機確認と分けて報告する。Task 11。

---

### Task 1: 事件・遮断理由・対処の土台

**Files:** `packages/shared/src/security.ts`（新規）、`packages/shared/src/index.ts`、`apps/api/src/security/{signals,incidents,actions,outbox}.ts`（新規）、`apps/api/drizzle/0030_security_incidents.sql`（新規、着手時に採番確認）、`apps/api/drizzle/meta/`、`apps/api/src/db/schema.ts`、`apps/api/test/{security-incidents,rls}.test.ts`

- `SecuritySignal` に source / sourceEventId / ruleVersion / occurredAt / severity / trusted target / evidenceDigest を定義する。`security_incidents`、`security_blocks`（app / account / ip の対象・理由・解除者・解除時刻）、`security_outbox`（一意な副作用キー、試行数、次回時刻、失敗コード）を作る。秘密値を含まない証拠だけを許可リストで受ける。
- 新設 `handleSecuritySignal` だけが自動対処を決める。事件・遮断・システム監査・outbox を同一 transaction で追記する。`(source, source_event_id)` の一意制約で重複を排除し、同じ事件の低→高への更新は対処を強める。低い判定で既存遮断を解除しない。
- アプリ理由はオーナーの `usage_states` と別管理。アカウントに対する明示的な遮断・凍結だけ `transitionUsageState` の新イベントと理由集合へ接続する（Task 9）。システム監査の actor は専用の system 型とし、既存 `admin_audit_log.operator_id` の FK に架空の運営者を作らない。
- **導入承認：不要**（既存 PostgreSQL・TypeScript）。マイグレーションは計画の作成時には実行しない。
- [ ] テスト：高・中・低の副作用／app と account の分離／偽 target 拒否／重複・再配送・同時昇格／監査失敗時の rollback／他人の事件・内部証拠の RLS／Review Focus 1・3

### Task 2: エッジでの遮断と再起動の防止

**Files:** `apps/api/src/security/{gate,internal-server}.ts`（新規）、`apps/static/src/{app,main,proxy}.ts`、`apps/api/src/apps/{wake,deployments}.ts`、`apps/api/src/ingest/{publish,dynamic}.ts`、`packages/platform/src/runtime/waker.ts`、`apps/api/package.json`（内部 export）、`dev/k8s/edge.yaml`、`apps/static/test/{static,dynamic,security}.test.ts`、`apps/api/test/security-gate.test.ts`

- `securityGate({appId, accountId?, clientIp})` を共通化。`createStaticApp` のサイト解決後、配信・`proxyDynamic`・`handleUpgrade` の前で確認し、遮断時は日英の「このサイトは一時停止中です」、503、no-store。`transfer.limit*` の月末解除メッセージとは分ける。IP / account ブロックは本体 API の入口でも適用する。
- Traefik の ForwardAuth 相当の内部判定口を localhost / 内部ネットワークだけに追加し、Host・正規化した経路・信頼された接続元から対象を解決する。`edge.yaml` の経路へ接続する。クライアントが内部ヘッダーを指定して許可を得られないことを固定する。
- `resolveClientIp` と `clientAddress` の既存 trusted hops を確認し、信頼したプロキシからの接続だけヘッダーを採用する共通処理へ寄せる。直アクセス・不足した転送ヘッダー・IPv4-mapped IPv6 を扱う。
- 有効なアプリ遮断を、`buildRunSpec`、wake lock 内の起動直前、`rolloutDynamic` の公開切替直前、静的 `processDeployment` の公開切替直前でも確認する。高は `RuntimeDriver.stop(appId)`。停止失敗は outbox に残し、次の worker が再試行する。
- 新設の接続 registry と DB の変更通知 + 定期再照合を使い、遮断 commit 時に既存 WebSocket・長時間ストリームを閉じる。複数 edge の通知欠損時も 1 秒以内の再照合で閉じる設計とし、偽時計で上限を検証する。CDN にセキュリティ判定を迂回した共有キャッシュを許さない設定契約を残す（本番 Cloudflare 設定は Phase 8）。
- **導入承認：原則不要**（既存 Traefik・DB・Node）。未導入の Traefik CRD / 画像が必要なら承認前に取得しない。
- [ ] テスト：静的・動的・HEAD / POST / Upgrade／偽 XFF・偽内部ヘッダー／停止失敗後も遮断／既存接続の切断／複数 edge・再起動／wake・再デプロイ・rollback と遮断の競合（`test/helpers/lockdb.ts` の別接続を再利用）／月初でも維持／Review Focus 2

### Task 3: Falco の取り込みとコンテナ異常

**Files:** `packages/platform/src/security/{falco,telemetry}.ts`（新規）、`apps/api/src/security/{internal-server,detectors}.ts`、`packages/platform/src/runtime/{docker,kubernetes,kubernetes-manifests}.ts`、`apps/worker/src/{worker,main}.ts`、`packages/platform/src/queue.ts`、`dev/security/falco/{rules,config}.yaml`（新規）、`scripts/security-falco.sh`（新規）、`packages/platform/test/security/falco.test.ts`（新規）

- Falco JSON → `SecuritySignal` の変換を作る。マイニング・脱出の試みは高。rule 名から severity を許可リストで解決する。container ID / pod UID / namespace / deployment を管理側の実データと照合し、利用者が変更できるラベルだけで対象を決めない。
- 内部リスナーは認証済み収集器だけ受ける。timestamp・nonce・署名または mTLS による認証、本文上限、再送 ID、許容時間差を設定する。シェル引数や環境変数を含む Falco の全文は保存しない。
- 生存確認、イベント欠損・drop 数、遅延、未知ルールを運営通知。未導入・未対応環境を正常と表示しない。Mac 自体ではなく Linux ノード側で導入する。gVisor の syscall 可視性と、ホスト側検知・アプリ内検知の範囲を実測し、見えない範囲を記録する。
- **導入承認：必要**。Falco、固定ルール、ノード側ドライバーと必要なら転送器（Falcosidekick 等）の画像・権限を先に提示する。実 Falco / Linux / k3d は単体・結合テストの前提にしない。実導入後の無害な検知確認は別の承認済みローカル検証。
- [ ] テスト：固定 JSON の高・未知・壊れた本文／署名偽装・再送／別 namespace・古い pod の誤帰属拒否／重複による二重停止なし／欠損通知／Review Focus 1・3

### Task 4: CPU・転送急増・外向き通信の検知

**Files:** `packages/platform/src/security/{telemetry,egress}.ts`（新規）、`apps/api/src/security/{detectors,thresholds}.ts`（新規）、`apps/api/src/grants/{entitlements,event-boost}.ts`、`apps/api/src/usage/transfer.ts`、`packages/platform/src/runtime/{docker,kubernetes-manifests}.ts`、`apps/worker/src/{worker,main}.ts`、`dev/security/egress.yaml`（新規）、テスト

- `RuntimeDriver` に現在 CPU 計測 API はない。新設 `TelemetryProvider` で Docker / Kubernetes の計測と偽実装を分離する。率・時間窓・必要サンプル数を設定化し、CPU がやや高い持続は低、マイニングは Falco 等の独立した証拠と併せて高にする。CPU だけでマイニングと断定しない。
- 外向き bytes / 接続数と配信 bytes を別に計測し、上限超過・急増を中の signal にする。承認済み event boost の有効期間だけ `resolveEntitlements` と付与 params を参照して**アクセス急増の基準だけ**緩和する。Falco・罠・Safe Browsing の基準は変えない。
- 外向き通信を明示プロキシへ強制する NetworkPolicy と接続記録の口を用意する。プロキシを迂回した TCP / UDP / IPv6 を拒否し、DNS、DB 接続、ヘルス確認を必要最小限の例外として定義する。TLS 本文は復号・保存しない。宛先は秘密を含まない分類情報だけにする。metadata・他テナント・本体・port 25 の既存制限を維持する。
- **導入承認：必要（実計測・外向き制御）**。採用するプロキシ / 計測収集器・画像・Kubernetes の計測機能を確定してから取得・適用する。未対応プロトコルの扱いを README に明示し、単に HTTP_PROXY を付けただけで強制済みとはしない。
- [ ] テスト：偽 metrics の時間窓・欠損・counter reset／CPU 低通知と高判定の区別／外向き急増／ブースト開始・終了・取消の境界／プロキシと NetworkPolicy の生成物／実通信を使わない遮断判定／Review Focus 3

### Task 5: ファイル配布・公開時フィッシング・通報

**Files:** `apps/api/src/security/{file-distribution,safe-browsing,reports}.ts`（新規）、`apps/static/src/{app,proxy}.ts`、`apps/api/src/apps/logs.ts`、`apps/api/src/ingest/{inspect,publish,dynamic}.ts`、`apps/api/src/apps/deployments.ts`、`apps/api/src/http/app.ts`、`apps/web/app/[locale]/report/page.tsx`（新規）、`packages/i18n/src/{ja,en}.ts`、テスト

- 固定窓の総 bytes・正規化したファイル ID ごとの実送信 bytes・外部参照元の比率で配布を検知する。初期候補は 10 分・100MiB 以上・単一ファイル 80% 以上・外部 origin 50% 以上（すべて設定で変更可能、境界テストを先に作る）。急増は Task 4 の独立ルール。正当なダウンロードや referrer 欠落を 1 件だけで不正としない。
- 静的・動的のストリームで実 bytes を数える。HEAD / 304 / 中断 / Range / chunked を定義し、転送量 meter と二重計上しない。クエリを落としたパスの keyed digest を集計に使い、日次ローテーション・30 日以内削除。既存 `createAccessLogger` はバッファ溢れで drop するため、事件・証拠配送の唯一の情報源にはしない。
- 新設 `SafeBrowsingClient` を静的公開・動的 rollout・rollback の切替前へ接続する。対象は利用者の公開 URL のみ。API key・内部ホスト・query・学生証 URL は送らない。悪性判定は高、タイムアウト / 未設定は検査待ちとして新しい公開を保留し、既存正常版を維持。未公開 URL が未登録だった結果を安全の保証としない。
- 公開ページの通報先と利用者 ID を検証する `POST /security/reports` を追加。回数制限・本文上限・個人情報削減。通報だけで自動凍結しない。HTML には日英の通報リンクを付け、動的・圧縮・ストリーム・CSP・Content-Length / ETag の整合を扱う。HTML 以外は `Link` ヘッダーで案内し、利用者の JS を信頼せず共通 edge で実施する。
- **導入承認：npm は不要**（注入可能な HTTP client）。**外部利用承認：Safe Browsing のサービス利用・資格情報・送信範囲が必要**。自動テストは偽応答のみ。
- [ ] テスト：集中率と直リンクの組合せ／欠落参照元・正当な大型配布／query 違いの集約／bytes の境界／悪性・未判定・timeout・前版維持／通報スパム／全 HTML 経路のリンクとヘッダー整合／Review Focus 2・3

### Task 6: VPN / プロキシ / Tor の本実装と入口の補完

**Files:** `packages/shared/src/network-reputation.ts`、`packages/platform/src/security/{network-reputation,network-data}.ts`（新規）、`apps/api/src/{config,server}.ts`、`apps/api/src/http/app.ts`、`apps/api/src/verification/submissions.ts`、`apps/upload/src/{main,server}.ts`、`packages/platform/src/pii/ingest.ts`、`scripts/security-network-update.sh`（新規）、テスト

- `NetworkReputation.check(ip)` を保ち、既存 `allowAllNetworks` を本番の既定から外す。IP 情報（MaxMind / IPinfo から必要な匿名化判定を提供する製品を選定）、Tor 出口一覧、Cloudflare の信頼済みボット情報を組み合わせる。一般 GeoIP だけで VPN を判定できるとは扱わない。
- 学校 CIDR と Private Relay の信頼済み例外 → VPN / proxy / Tor の順に判定。IPv4 / IPv6、壊れた IP、データの版・取得時刻・最大有効期間を検証。更新は検証成功後に atomic swap、失敗時は期限内の前版を使用、期限切れは unknown。unknown は保護対象操作だけ 503（既知の VPN 等は 403）、全閲覧を止めない。
- 現状 `POST /auth/signup` は `registerAccount` を直接呼び、network 判定がないので必ず追加する。`/verification/start` の既存注入と、実際の `/ingest/id-upload` の接続元確認も補完し、通常回線で token 取得後に VPN へ切り替える迂回を防ぐ。拒否時は account / session / blob を作らない。
- Web の Pro 申込拒否とストア申込許可は将来用の `NetworkAction` 判定としてテストし、Phase 7 / 9 の未存在ルートは作らない。通常ログイン・サイト変更・閲覧には VPN だけの拒否を追加しない。管理画面は既存 Tailscale gate のまま。
- **導入承認：必要**。IP 製品・例外リスト・Tor データの取得、利用条件・更新頻度を提示。MMDB を選ぶ場合の npm reader も追加前に固定版を提示する。fixtures は人工 CIDR と固定判定のみで、実データ・実 Cloudflare は不要。
- [ ] テスト：全操作の許可表／学校・Relay と Tor 重複時の例外優先／罠は免除されない／偽ヘッダー／IPv6／期限切れ・更新失敗／登録・提出開始・取り込みの実配線／拒否時に副作用なし／Review Focus 3

### Task 7: ハニートークン全 7 種と探索 IP の遮断

**Files:** `apps/api/src/security/{honeytokens,decoys,scan-detector}.ts`（新規）、`apps/api/src/http/app.ts`、`packages/platform/src/security/{honeytokens,db-audit}.ts`（新規）、`packages/platform/src/pii/schema.ts`、`apps/api/src/db/schema.ts`、`packages/platform/src/runtime/kubernetes-manifests.ts`、`apps/admin/src/page.ts`、`scripts/security-honeytokens.sh`（新規）、`dev/security/`、テスト

- 罠の registry は token の HMAC・種別・匿名の配置 ID・有効期間だけ。値は承認済み配備時に生成し、リポジトリ・ログ・本番資格情報を使わない。外部の実クラウド権限を持つ鍵は作らず、独自の偽 credential 検証口への使用で発火させる。実クラウドに対する使用までは観測できない限界を明記する。
- 配置と発火を 7 種とも定義：①設定 / env / コンテナの偽鍵（偽認証口・Falco のファイル読取り）、②本体 DB の偽管理者（権限なしの decoy 行・DB 監査）、③個人情報 DB の偽学生（完全な合成データ・DB 監査）、④リポジトリ奥 / バックアップの偽 API key（配備時に生成した作業コピー / 専用 decoy オブジェクト・偽認証口）、⑤偽内部 URL（本体側の隔離された decoy endpoint）、⑥本体ドメイン限定 `/.env`（偽鍵だけ、no-store）、⑦偽 `/admin/login`（POST 入力の存在で発火、本文・パスワードは保存しない）。
- 偽管理者は本物の `operators` / `passkeys` / セッションを持たせず、偽学生も提出・付与・メール・7 日削除の実データ経路に混ぜない。PII 監査の出力は許可した罠 ID と時刻だけ。SELECT を DB トリガーで検知できるという設計にはせず、DB 監査ログから decoy 専用 relation への読取りを検出する。
- `/.env` と `/admin/login` は公開本体の decoy 専用ルートだけ。公開 API に本物の管理 API を mount しない。利用者サイトのドットファイルは既存 `parsePath` により 404 のまま。隠しリンクは実管理画面への導線にしない。
- `/.git/config` / `/wp-admin` 等の探索は時間窓で集約し、探索する送信元 IP を遮断する。被害側アプリをその訪問者だけで止めない。罠の入力・使用は信頼できる IP / 認証済み account だけを即遮断し、最優先の運営通知と監査を残す。IP が取得不能なら共有の `unknown` を遮断しない。偽フォームの GET だけで入力したと判断しない。
- **導入承認：必要（実 DB 読取り検知）**。PostgreSQL 監査拡張（例：pgAudit）と log collector の版・画像・監査範囲を提示する。Falco 導入は Task 3 の承認を再利用。実機なしのテストは監査ログ fixture で行い、env の窃取や検知不能なバックアップのオフライン読取りまで検知済みとはしない。
- [ ] テスト：7 種の配置 descriptor と発火／本番資格情報・PII 不在／罠 ID なしの通常 DB アクセスは非発火／重複最優先通知／偽フォーム本文の非保存／本体と利用者ドメイン分離／探索 IP のみ遮断／Review Focus 4

### Task 8: Object Lock への監査配送と外部 checkpoint

**Files:** `packages/platform/src/security/audit-storage.ts`（新規）、`apps/api/src/security/{system-audit,audit-export}.ts`（新規）、`apps/api/src/admin/audit-log.ts`、`apps/api/drizzle/0031_security_audit.sql`（新規、採番確認）、`apps/api/drizzle/meta/`、`apps/api/src/db/schema.ts`、`packages/platform/src/queue.ts`、`apps/worker/src/{worker,main}.ts`、`apps/api/src/scripts/verify-security-audit.ts`（新規）、テスト

- 専用 `AuditStorage` に append / readVersion / verifyRetention を定義。既存 `@aws-sdk/client-s3` の command を利用するが、一般 `BucketStorage.delete*` は渡さない。Object Lock・versioning・COMPLIANCE 保持を満たす専用 bucket が必要。worker には追記・必要な検証読取りのみ、削除・保持短縮・bypass・bucket 設定変更権限を与えない。
- 管理監査は既存連鎖を変更せず連続範囲で輸出。システム監査は専用 actor・追記専用 trigger・直列化した連鎖と outbox を追加する。旧管理記録は PII 検査後に原本 digest と匿名化 export を対応付け、原本のメールや detail 全文を無条件に WORM へコピーしない。
- バッチには stream ID・連番範囲・前バッチ digest・各行の元 hash・匿名化 payload digest・版を入れる。S3 の version ID・retain-until を確認してから配送済みにする。応答喪失時は固定 batch ID と digest を照合して再試行し、競合内容を上書きしない。二重 worker・DB commit 後 crash・S3 完了後 crash を扱う。
- 独立した読み取り資格情報で Object Lock 側の最新 checkpoint と DB の head を比較し、行改ざん・途中抜け・末尾切り捨て・古い DB への復元を検知する。DB 内の `verifyAuditChain` が成功しただけでは WORM 配送済みと表示しない。
- 配送遅延・最終成功時刻・未配送数・保持検証失敗を運営通知。S3 障害でも即時防御は DB/outbox に確定して継続し、記録の破棄や配送済みの偽装はしない。長期障害で outbox 容量が限界に近づいたら新規公開と管理変更を保留し、既存の遮断を維持する。
- **導入承認：npm は原則不要**。**外部設定の承認：保管サービス・リージョン・保持期間・料金・COMPLIANCE の解除不能性を確定するまで bucket を作らない**。ローカル Object Lock 対応ストレージを追加する場合も画像取得前に承認。fake S3 の通過は本番の不変性の実証と区別する。
- [ ] テスト：追記専用・並列連鎖／保持指定なしの拒否／削除・保持短縮・同 key への新 version でも元版が残る契約／改ざん・欠番・末尾切り捨て／配送再試行・版確認・障害通知／WORM に秘密値なし／Review Focus 5

### Task 9: 通知・異議申し立て・管理操作

**Files:** `apps/api/src/security/{notifications,appeals}.ts`（新規）、`apps/api/src/admin/security.ts`（新規）、`apps/api/src/admin/{server,operations,dangerous}.ts`、`apps/api/src/usage/state.ts`、`packages/shared/src/usage-state.ts`、`apps/api/src/http/app.ts`、`apps/api/src/mail/mailer.ts`、`apps/admin/src/{client,page}.ts`、`apps/web/app/[locale]/security/page.tsx`（新規）、`packages/i18n/src/{ja,en}.ts`、テスト

- 8 章の通知の共通配送口を作り、メールと Web の通知を outbox で冪等に送る。スマホは adapter のみ（Phase 9）。理由・解除を自分でできないこと・異議申し立て先を利用者へ、事件 ID と Tailscale 管理 URL を運営者へ。罠は最優先 queue を使い、通常通知の滞留に埋もれないようにする。
- 利用者は本人の事件の公開可能な理由と対処を確認し、回数・文字数制限付きで異議申し立てできる。IP / account が遮断されても、本人確認と rate limit を通した異議申し立て・ログアウトには到達できるよう限定例外を作る。証拠や検知器の秘密値は見せない。
- 管理 API の一覧・詳細・解除・停止継続・凍結は既存 `createAdminApp` にだけ追加。`auditedSystem` で理由の解除と監査を同一 transaction にし、reconcile により既存の quota・手動停止・他事件が残れば起動しない。
- account の security block / freeze は `shared/usage-state.ts` の専用理由と `transitionUsageState` のイベントを追加し、手動理由と相互に消さない。アカウント凍結は本人の動的・静的双方の gate に反映し、既存のチーム帰属規則も確認する。自動凍結はせず運営者の明示操作。凍結解除は既存の 24 時間予約だけで行い、事件解除では迂回できない。
- **導入承認：不要**。既存 `Mailer` の偽実装を使う。本番通知サービスの契約は Phase 8。
- [ ] テスト：利用者と運営者への日英通知／最優先・重複排除・送信失敗再試行／本人以外の事件拒否／Tailscale・昇格 gate／閲覧も監査／異議申し立ての限定例外／同時解除と新事件／凍結解除 24 時間と残る停止理由／Review Focus 1・6

### Task 10: 設定・運用手順・導入前レビュー

**Files:** `README.md`、`docs/security/phase6-operations.md`（新規）、`apps/api/src/config.ts`、`apps/admin/README.md`、`dev/security/`、`scripts/doctor.sh`、テスト

- 導入順は Task 1・8 の監査基盤 → Task 2 の gate → Task 9 の復旧口 → Task 3〜7 の検知器 → Task 11。各 detector は test / observe / enforce を設定で区別し、本番が未設定・未知状態・observe のままなら防御完了と表示しない。依存未導入の機能を doctor が個別に報告する。
- 設定値は schema と `platform_settings` の既知キーで検証し、変更前後を監査する。時間窓・閾値・例外リスト・更新期限・配送遅延基準・outbox 容量・通知先の意味と初期値を記載する。未知キー、負数、無制限設定を拒否する。
- 承認用の一覧に Task 3 Falco、Task 4 プロキシ / metrics、Task 6 IP データ / 任意 npm、Task 7 DB 監査、Task 5 外部 URL 検査、Task 8 WORM をまとめる。ソフト取得・適用・有料契約・外部送信・解除不能な保持をそれぞれ区別する。
- 罠の生成・rotation・失効、誤検知解除、停止失敗、検知器停止、S3 配送失敗、checkpoint 不一致の手順を書く。緊急時も証拠・データを削除せず、運営者の認証経路を維持する。Phase 8 の GitOps / Cloudflare / Talos 配備へ引き継ぐ。
- **導入承認：この Task は文書と設定検証のみで不要**。具体的な導入実行は上記の個別承認後。
- [ ] テスト：本番の許可しすぎる既定値拒否／設定変更の監査／doctor の未導入・期限切れ・未配送の表示／解除手順が他理由を消さない／Review Focus 6

### Task 11: 外部サービスなしの結合テストと完了確認

**Files:** `apps/api/test/security-*.test.ts`、`apps/static/test/security.test.ts`、`apps/worker/test/security.test.ts`、`packages/platform/test/security/`、`packages/shared/test/security.test.ts`、`apps/admin/test/`、`apps/web/e2e/security.spec.ts`（新規）、`apps/web/e2e/helpers.ts`、`docs/superpowers/plans/2026-10-24-phase6-defenses-ledger.md`

- 既存 `withTestDb` でローカル使い捨て DB、`openLocker` / 別 connection pool で実競合、fake runtime・偽 S3 command transport・fake network / Falco / Safe Browsing・収集した偽 mail を使う。CI の外部 HTTP / DNS を拒否し、fixture にない要求は即失敗させる。Falco / pgaudit / IP データ取得はテストセットアップから呼ばない。
- 通常 E2E は内部テスト入力で事件を作り、静的・動的が遮断 → 日英通知と異議申し立て → Tailscale 管理画面の解除 → 別理由がなければ復旧、を確認する。高の停止、罠、VPN の登録・提出拒否、ブースト境界、WORM の検証失敗も結合テストに含める。テスト用注入ルートは本番に存在させない。
- `pnpm lint`、`pnpm typecheck`、`pnpm test` と既存 web / upload の Playwright を回し、既存 Phase 5 の審査・暗号文削除・付与・管理分離も回帰確認する。ブラウザが不足していれば取得前に承認し、未実行として台帳に残す。
- 台帳は実装後に Task ごとの変更ファイル・実行コマンド・結果・未確認点・承認状況を追記する。オフライン自動テスト完了と、承認後の実 Linux/Falco 可視性・プロキシ迂回防止・DB 読取り監査・本物の Object Lock 保持検証を分ける。後者が未確認なら「本番防御完了」としない。
- **導入承認：既存ツールがあれば不要**。不足するブラウザ・DB イメージ等の取得、実 Falco / Object Lock の任意検証は承認後のみ。自動テストに本物の外部サービスを必要とさせない。
- [ ] E2E：検知 → 遮断 → 通知 → 異議申し立て → 記録付き解除／高は停止・中はコンテナ維持・低は通知のみ／VPN と例外／罠全種の入力／WORM 障害と再配送／既存 Phase 5 回帰／Review Focus 1〜7

---

## フェーズ 6 でやらないこと

- この計画の作成時点での製品コード変更、ソフト導入、データ取得、サービス操作、SSH、本番反映、コミット。台帳は空で作成する。
- 本番クラウド選定、Talos / ノード定期再作成、Cilium mTLS、Workload Identity / Vault / KMS、Cloudflare Tunnel と CDN 設定、GitOps・ACL の実配備（Phase 8）。Phase 6 では検知・遮断インターフェースとローカル設定、適用条件・未検証箇所を渡す。
- Stripe の決済・Pro の契約口・ストア決済（Phase 7 / 9）。VPN の操作別ポリシーだけ先に用意する。
- スマホの実 push 配送（Phase 9）、本番メールサービスの契約（Phase 8）、新たな有料通知サービス。
- 外部脆弱性診断・規約の法的確定・ドメイン保護チェックリストの本番適用（Phase 10）、バックアップ全体の別クラウド WORM 化と月次復元運用（Phase 8）。今回の Object Lock は操作と防御の監査記録。
- 実クラウドの権限を持つ罠、学生証や実学生情報を使う罠、証拠としての本文・秘密値の保存、単なる VPN 利用や通報 1 件による自動アカウント凍結。
