# フェーズ 1（土台）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mac と Ubuntu でコマンド 1 つで開発環境が立ち上がり、パスワードなし（メール＋QR 照合、パスキー）でログインでき、復旧コード・ログイン履歴・チームのデータ構造・日英の表示がそろった状態にする。

**Architecture:** pnpm モノレポ。`apps/api`（Hono + Drizzle + PostgreSQL）が唯一の窓口で、`apps/web`（Next.js）は API だけを呼ぶ。ルール・型・文言は `packages/shared` と `packages/i18n` に置く。開発用の依存（PostgreSQL、MinIO、Mailpit）は Docker Compose、Kubernetes は k3d で 2 クラスタ（本体用・利用者用）を作るスクリプトだけ用意する（フェーズ 2 以降で使う）。

**Tech Stack:** Node.js 22 LTS、pnpm 9、TypeScript 5（strict）、Hono、Drizzle ORM + `postgres`、Vitest、Next.js 15（App Router）、`@simplewebauthn/server` / `@simplewebauthn/browser`、`@node-rs/argon2`、`nodemailer`、`qrcode`、Docker Compose、k3d。

**Spec:** `docs/superpowers/specs/2026-10-15-platform-design.md`（主に 1.3〜1.5、2、8、9.3、9.10、11 章）

## Global Constraints

- 言語は TypeScript（strict）のみ。全パッケージ ESM。
- パスワードは一切持たない。パスワード入力欄を作らない。
- 集めるのはメールアドレス・表示名・言語だけ。本名・住所・電話番号は集めない。
- 生年月日は保存しない。保存するのは `ageVerified13: true` と `adultFrom`（18 歳になる年月、`YYYY-MM`）だけ。13 歳未満は登録不可。
- メールアドレスは AES-256-GCM で暗号化して保存し、照合には HMAC-SHA256 のハッシュ（`emailHash`）を使う。
- メールのログインコードとリンクは 1 回きり、有効期限 10 分。
- 復旧コード：16 文字、1 人 1 つ、Argon2id のハッシュだけを保存、入力は NFKC で正規化。
- チーム：最大 10 人、役割は `owner` / `admin` / `member`、オーナーは常に 1 人。
- 表示言語は `ja` と `en`。画面・メールの文言はすべて `packages/i18n` から取る。
- Kubernetes を直接操作するのは API とワーカーだけ（フェーズ 1 では操作しない）。
- 本番用の `.env` は作らない。開発用は `.env.development`（コミットしない、`.env.development.example` をコミット）。
- 開発環境は Mac（Apple Silicon / Intel）と Ubuntu 22.04+ の両方で `pnpm dev:up` 1 つで立ち上がること。

## Review Focus

1. **メールアドレスの大文字・小文字・前後の空白違い**（`Foo@Example.com ` と `foo@example.com`）→ 同じアカウントとして扱う。Task 3 のテストで固定する。
2. **ログインコードの使い回し・期限切れ・総当たり**（同じコードを 2 回、11 分後、6 回間違い）→ すべて拒否、5 回失敗でそのチャレンジを無効化。Task 5 のテストで固定する。
3. **QR 照合で違う数字を選んだ／別のチャレンジの QR を読んだ** → ログイン不成立、そのチャレンジは無効化。Task 6 のテストで固定する。
4. **復旧コードの全角・半角・ひらがなとカタカナの入力ゆれ**（`Ａ` と `A`、全角記号）→ NFKC 後に一致すれば成功。ただし紛らわしい文字は最初から生成しない。Task 7 のテストで固定する。
5. **チームのオーナーが 0 人・2 人になる操作**（最後のオーナーの脱退、オーナーの二重付与）と 11 人目の招待 → すべて拒否。Task 9 のテストで固定する。

---

## ファイル構成

```
package.json / pnpm-workspace.yaml / tsconfig.base.json / vitest.workspace.ts
.env.development.example
dev/compose.yaml                 PostgreSQL 16, MinIO, Mailpit
dev/k3d/platform.yaml            本体クラスタ定義
dev/k3d/tenant.yaml              利用者クラスタ定義
scripts/dev-up.sh / dev-down.sh  開発環境の起動・停止（Mac/Ubuntu 共通）
scripts/doctor.sh                必要ツールの確認

packages/shared/src/
  age.ts             年齢判定
  recovery-code.ts   復旧コードの文字集合・生成・正規化
  team-rules.ts      チームのルール（人数・役割）
  index.ts
packages/i18n/src/
  ja.ts / en.ts / index.ts      文言と t() 関数

apps/api/src/
  config.ts          環境変数の読み込みと検証
  db/schema.ts       Drizzle スキーマ
  db/client.ts
  db/migrations/     drizzle-kit で生成
  crypto/email.ts    メールの暗号化・ハッシュ
  mail/mailer.ts     メール送信（開発は Mailpit）
  auth/accounts.ts   登録
  auth/email-login.ts    メールのコード・リンク
  auth/cross-device.ts   QR ＋数字照合
  auth/passkeys.ts       パスキー
  auth/sessions.ts       セッション・端末一覧・強制ログアウト
  auth/recovery.ts       復旧コード・復旧申請
  auth/login-history.ts  ログイン履歴・新しい端末の通知
  teams/teams.ts
  http/app.ts        Hono アプリ（ルート定義）
  http/middleware.ts セッション確認・回数制限
  server.ts
apps/api/test/       各モジュールのテスト（Testcontainers は使わず compose の DB を使う）

apps/web/            Next.js（ログイン・登録・端末一覧・復旧・チーム画面）
```

---

### Task 1: モノレポと開発環境

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.gitignore`, `.env.development.example`
- Create: `dev/compose.yaml`, `dev/k3d/platform.yaml`, `dev/k3d/tenant.yaml`
- Create: `scripts/dev-up.sh`, `scripts/dev-down.sh`, `scripts/doctor.sh`
- Create: `docs/dev-setup.md`
- Modify: `README.md`

**Interfaces:**
- Produces: ルートのスクリプト `pnpm dev:up` / `pnpm dev:down` / `pnpm doctor` / `pnpm test` / `pnpm lint` / `pnpm typecheck`。DB 接続 URL `postgres://platform:platform@localhost:54320/platform`、Mailpit の SMTP `localhost:1025` / 画面 `http://localhost:8025`、MinIO `http://localhost:9000`。

- [ ] **Step 1:** `scripts/doctor.sh` を書く。`docker`、`node`（22 以上）、`pnpm`、`k3d` の有無とバージョンを調べ、足りないものを OS 別（`uname` で Darwin / Linux を判定）のインストール方法つきで表示し、1 つでも足りなければ終了コード 1。
- [ ] **Step 2:** `dev/compose.yaml` を書く。PostgreSQL 16（ポート 54320）、MinIO（9000/9001）、Mailpit（1025/8025）。各サービスに healthcheck を付け、データは名前付きボリューム。
- [ ] **Step 3:** k3d の設定 2 つを書く。`platform`（API 用、ロードバランサ 8080:80）と `tenant`（利用者用、8081:80、フェーズ 3 で gVisor を入れるためエージェント 1 台）。
- [ ] **Step 4:** `scripts/dev-up.sh` を書く。`doctor.sh` → `docker compose up -d --wait` → k3d クラスタが無ければ作成 → `pnpm --filter api db:migrate`。`--no-k8s` オプションで k3d を飛ばせる。`dev-down.sh` はその逆（ボリュームは `--purge` のときだけ消す）。`set -euo pipefail`、bash 3.2（macOS 標準）でも動く書き方にする（連想配列を使わない）。
- [ ] **Step 5:** 動作確認。Run: `pnpm dev:up --no-k8s && docker compose -f dev/compose.yaml ps`。Expected: 3 サービスとも `healthy`。
- [ ] **Step 6:** `docs/dev-setup.md` に Mac / Ubuntu それぞれの準備手順と `pnpm dev:up` の使い方を書き、README からリンクする。
- [ ] **Step 7:** Commit `chore: set up monorepo and dev environment`

---

### Task 2: 共通ルール（年齢・文言）

**Files:**
- Create: `packages/shared/src/age.ts`, `packages/shared/src/index.ts`, `packages/shared/test/age.test.ts`
- Create: `packages/i18n/src/{ja,en,index}.ts`, `packages/i18n/test/i18n.test.ts`

**Interfaces:**
- Produces:
  - `checkAge(birthDate: string /* YYYY-MM-DD */, today: Date): { ok: true; adultFrom: string /* YYYY-MM */ } | { ok: false; reason: 'under13' | 'invalid' }`
  - `type Locale = 'ja' | 'en'`、`t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string`、`MessageKey` は `ja.ts` のキーから型で作る

- [ ] **Step 1: 失敗するテストを書く**

```ts
// age.test.ts
const today = new Date('2026-10-15');
expect(checkAge('2013-10-15', today)).toEqual({ ok: true, adultFrom: '2031-10' }); // ちょうど13歳
expect(checkAge('2013-10-16', today)).toEqual({ ok: false, reason: 'under13' });
expect(checkAge('2000-02-29', today)).toEqual({ ok: true, adultFrom: '2018-02' });
expect(checkAge('2026-13-01', today)).toEqual({ ok: false, reason: 'invalid' });
expect(checkAge('2030-01-01', today)).toEqual({ ok: false, reason: 'invalid' }); // 未来

// i18n.test.ts
expect(t('ja', 'login.codeSent', { email: 'a@b.c' })).toContain('a@b.c');
expect(t('en', 'login.codeSent', { email: 'a@b.c' })).toContain('a@b.c');
// ja と en のキーが完全に一致すること
expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
```

- [ ] **Step 2:** Run: `pnpm --filter shared --filter i18n test` → FAIL
- [ ] **Step 3:** 実装する。`en.ts` は `satisfies Record<keyof typeof ja, string>` で、キーの漏れを型エラーにする。プレースホルダは `{name}` 形式。
- [ ] **Step 4:** Run 同上 → PASS
- [ ] **Step 5:** Commit `feat(shared): add age check and ja/en messages`

---

### Task 3: API の骨組み、DB スキーマ、メールの暗号化

**Files:**
- Create: `apps/api/src/{config.ts,server.ts}`, `apps/api/src/db/{schema.ts,client.ts}`, `apps/api/drizzle.config.ts`
- Create: `apps/api/src/crypto/email.ts`, `apps/api/test/crypto-email.test.ts`
- Create: `apps/api/src/http/app.ts`（`GET /healthz` のみ）, `apps/api/test/helpers/db.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config`（`DATABASE_URL`、`EMAIL_ENC_KEY`（32 バイト base64）、`EMAIL_HASH_KEY`（32 バイト base64）、`APP_ORIGIN`、`SMTP_URL`、`ADMIN_EMAIL`、`RP_ID`。足りなければ起動時に例外）
  - `normalizeEmail(raw: string): string`（前後の空白を削除、NFKC、小文字化）
  - `hashEmail(normalized: string, key: Buffer): string`（HMAC-SHA256、hex）
  - `encryptEmail(normalized: string, key: Buffer): string` / `decryptEmail(blob: string, key: Buffer): string`（AES-256-GCM、`base64(iv|tag|ciphertext)`）
  - テーブル（`schema.ts`）：
    - `accounts(id uuid pk, emailHash text unique, emailEnc text, displayName text, locale text, adultFrom text, recoveryCodeHash text null, createdAt)`
    - `sessions(id uuid pk, accountId fk, tokenHash text unique, deviceLabel text, createdAt, lastSeenAt, revokedAt null)`
    - `email_challenges(id uuid pk, accountId fk null, emailHash, purpose 'login'|'signup', codeHash, linkTokenHash, requesterDeviceId text, attempts int, consumedAt null, expiresAt, crossDeviceNumber int null, crossDeviceState text null)`
    - `passkeys(id text pk /* credentialID */, accountId fk, publicKey bytea, counter bigint, transports text[], createdAt, lastUsedAt)`
    - `login_events(id, accountId, method 'passkey'|'email'|'recovery', deviceLabel, region text null, ipPrefix text, createdAt)`
    - `recovery_requests(id, accountId, status 'pending'|'approved'|'rejected', createdAt, decidedAt null)`
    - `teams(id, name, createdAt)`、`team_members(teamId, accountId, role, pk(teamId, accountId))`
    - `owners(id uuid pk, kind 'account'|'team', accountId null, teamId null)` ＋ CHECK 制約（どちらか一方だけ）。後のフェーズの「アプリの持ち主」はこの id を参照する
  - テスト用 `withTestDb(fn)`：テストごとにスキーマを作り直す

- [ ] **Step 1: 失敗するテストを書く**

```ts
expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
expect(normalizeEmail('ｆｏｏ＠example.com')).toBe('foo@example.com'); // 全角
expect(hashEmail('foo@example.com', k)).toBe(hashEmail(normalizeEmail('FOO@example.com'), k));
const blob = encryptEmail('foo@example.com', k);
expect(blob).not.toContain('foo');
expect(decryptEmail(blob, k)).toBe('foo@example.com');
expect(encryptEmail('foo@example.com', k)).not.toBe(blob); // IV が毎回違う
expect(() => decryptEmail(tamper(blob), k)).toThrow();       // 改ざん検知
expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
```

- [ ] **Step 2:** Run: `pnpm --filter api test crypto-email` → FAIL
- [ ] **Step 3:** 実装する。暗号化は `node:crypto` の `createCipheriv('aes-256-gcm')`、IV は 12 バイトのランダム。
- [ ] **Step 4:** `pnpm --filter api db:generate && pnpm --filter api db:migrate` でマイグレーションを作って適用し、`GET /healthz` が `200 {"ok":true}` を返すことを `curl localhost:3001/healthz` で確認する。
- [ ] **Step 5:** Run: `pnpm --filter api test` → PASS
- [ ] **Step 6:** Commit `feat(api): add api skeleton, schema and email encryption`

---

### Task 4: セッションとメール送信

**Files:**
- Create: `apps/api/src/auth/sessions.ts`, `apps/api/src/mail/mailer.ts`, `apps/api/src/http/middleware.ts`
- Test: `apps/api/test/sessions.test.ts`

**Interfaces:**
- Consumes: Task 3 のスキーマ、`t()`
- Produces:
  - `createSession(db, accountId: string, deviceLabel: string): Promise<{ token: string; sessionId: string }>`（トークンは 32 バイトのランダムを base64url、DB には SHA-256 だけを保存）
  - `resolveSession(db, token: string): Promise<{ accountId: string; sessionId: string } | null>`（失効・取り消し済みは null。`lastSeenAt` を更新）
  - `listSessions(db, accountId): Promise<SessionView[]>` / `revokeSession(db, accountId, sessionId): Promise<void>`（他人のセッションは取り消せない）
  - セッションの有効期限：最終利用から 30 日
  - `sendMail(to: string, subject: string, text: string): Promise<void>`（`SMTP_URL` に nodemailer で送る）
  - ミドルウェア `requireSession`（Cookie `sid`、`HttpOnly; Secure; SameSite=Lax; Path=/`）と `rateLimit(key: string, max: number, windowSec: number)`（フェーズ 1 はメモリ上で十分）

- [ ] **Step 1: 失敗するテストを書く**

```ts
const { token, sessionId } = await createSession(db, a.id, 'Mac / Safari');
expect((await resolveSession(db, token))?.accountId).toBe(a.id);
expect(await db.select().from(sessions)).not.toContainEqual(expect.objectContaining({ tokenHash: token }));
await revokeSession(db, b.id, sessionId);               // 他人は取り消せない
expect(await resolveSession(db, token)).not.toBeNull();
await revokeSession(db, a.id, sessionId);
expect(await resolveSession(db, token)).toBeNull();
vi.setSystemTime(Date.now() + 31 * 86400_000);
expect(await resolveSession(db, (await createSession(db, a.id, 'x')).token)).not.toBeNull(); // 新しいものは有効
```

- [ ] **Step 2:** FAIL を確認 → **Step 3:** 実装 → **Step 4:** PASS を確認
- [ ] **Step 5:** Commit `feat(api): add sessions, mailer and middleware`

---

### Task 5: 登録とメールでのログイン

**Files:**
- Create: `apps/api/src/auth/accounts.ts`, `apps/api/src/auth/email-login.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/test/email-login.test.ts`

**Interfaces:**
- Consumes: Task 2〜4
- Produces:
  - `startEmailChallenge(db, mailer, input: { email: string; purpose: 'login' | 'signup'; locale: Locale; requesterDeviceId: string }): Promise<{ challengeId: string }>`
    - 6 桁の数字コードと、リンク用トークン（32 バイト）を作り、両方ハッシュで保存。メールにコードとリンク `APP_ORIGIN/login/link?c=<challengeId>&t=<token>` を書く
    - 登録されていないメールで `login` を要求しても、同じ応答を返す（アカウントの有無を漏らさない）。メールは送らない
  - `verifyEmailCode(db, challengeId: string, code: string, requesterDeviceId: string): Promise<{ accountId: string } | { error: 'invalid' | 'expired' | 'locked' }>`
  - `registerAccount(db, input: { challengeId: string; code: string; displayName: string; birthDate: string; locale: Locale }): Promise<{ accountId: string; recoveryCode: string } | { error: 'under13' | 'invalid' | 'exists' }>`（復旧コードの生成は Task 7 の関数を呼ぶ。このタスクでは Task 7 が先に終わっている前提で並べ替えてよい）
  - HTTP：`POST /auth/email/start`、`POST /auth/email/verify`、`POST /auth/signup`。成功時は Cookie を発行。回数制限：同じメールハッシュへの開始は 10 分に 3 回、同じ IP は 10 分に 20 回

- [ ] **Step 1: 失敗するテストを書く**（Mailpit の代わりに、送信内容を記録するテスト用 mailer を渡す）

```ts
const { challengeId } = await startEmailChallenge(db, mail, { email: 'Foo@Example.com ', purpose: 'login', locale: 'ja', requesterDeviceId: 'd1' });
const code = mail.lastCode();
expect(await verifyEmailCode(db, challengeId, code, 'd1')).toEqual({ accountId: a.id });
expect(await verifyEmailCode(db, challengeId, code, 'd1')).toEqual({ error: 'invalid' });   // 再利用不可
// 期限切れ
vi.setSystemTime(Date.now() + 11 * 60_000);
expect(await verifyEmailCode(db, c2, code2, 'd1')).toEqual({ error: 'expired' });
// 5回失敗でロック、その後は正しいコードでも不可
for (let i = 0; i < 5; i++) await verifyEmailCode(db, c3, '000000', 'd1');
expect(await verifyEmailCode(db, c3, code3, 'd1')).toEqual({ error: 'locked' });
// 存在しないメールでも同じ形の応答、メールは送られない
expect(await startEmailChallenge(db, mail, { email: 'nobody@x.y', purpose: 'login', locale: 'ja', requesterDeviceId: 'd1' })).toHaveProperty('challengeId');
expect(mail.sentTo('nobody@x.y')).toBe(false);
// 登録：13歳未満は拒否、生年月日は DB に残らない
expect(await registerAccount(db, { ...s, birthDate: '2015-01-01' })).toEqual({ error: 'under13' });
const r = await registerAccount(db, { ...s, birthDate: '2008-04-02' });
expect(JSON.stringify(await db.select().from(accounts))).not.toContain('2008-04-02');
expect(r).toHaveProperty('recoveryCode');
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装（コードの比較は `timingSafeEqual`） → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(api): add signup and email login`

---

### Task 6: 別の端末でリンクを押したときの QR ＋数字照合

**Files:**
- Create: `apps/api/src/auth/cross-device.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/test/cross-device.test.ts`

**Interfaces:**
- Consumes: Task 5 の `email_challenges`
- Produces:
  - `openEmailLink(db, challengeId: string, linkToken: string, openerDeviceId: string): Promise<{ result: 'logged_in'; accountId: string } | { result: 'cross_device_pending' } | { error: 'invalid' | 'expired' }>`
    - 同じ端末（`openerDeviceId === requesterDeviceId`）ならそのままログイン
    - 別の端末なら、10〜99 の数字を 1 つ決めて保存し、状態を `awaiting_scan` にする
  - `getRequesterScreen(db, challengeId: string, requesterDeviceId: string): Promise<{ state: 'awaiting_scan'; qrPayload: string; number: number } | { state: 'approved' } | { state: 'none' }>`（`qrPayload` は `APP_ORIGIN/login/confirm?c=<id>&s=<scanToken>`、`scanToken` は 1 回きり）
  - `getConfirmChoices(db, challengeId: string, scanToken: string): Promise<{ choices: [number, number, number]; requesterDevice: string; region: string | null } | { error: 'invalid' }>`（正解 1 つ＋ダミー 2 つを並べ替えて返す）
  - `confirmNumber(db, challengeId: string, scanToken: string, chosen: number): Promise<{ ok: true } | { error: 'mismatch' | 'invalid' }>`（間違えたらチャレンジを無効化）
  - 要求した端末は `getRequesterScreen` を 2 秒ごとに呼び、`approved` になったら `POST /auth/email/complete` でセッションを受け取る
  - デバイス ID は、初回アクセス時に発行する Cookie `did`（ランダム、`HttpOnly`）

- [ ] **Step 1: 失敗するテストを書く**

```ts
expect(await openEmailLink(db, c, tok, 'd1')).toEqual({ result: 'logged_in', accountId: a.id });   // 同じ端末
expect(await openEmailLink(db, c2, tok2, 'phone')).toEqual({ result: 'cross_device_pending' });
const scr = await getRequesterScreen(db, c2, 'd1');
expect(scr.state).toBe('awaiting_scan');
expect(await getRequesterScreen(db, c2, 'attacker')).toEqual({ state: 'none' });                // 他の端末からは見えない
const { choices } = await getConfirmChoices(db, c2, scanTokenOf(scr));
expect(choices).toContain(scr.number);
expect(new Set(choices).size).toBe(3);
expect(await confirmNumber(db, c2, scanTokenOf(scr), wrong(choices, scr.number))).toEqual({ error: 'mismatch' });
expect(await confirmNumber(db, c2, scanTokenOf(scr), scr.number)).toEqual({ error: 'invalid' }); // 一度間違えたら無効
// 別のチャレンジのスキャントークンでは確認できない
expect(await confirmNumber(db, c3, scanTokenOf(scr), scr.number)).toEqual({ error: 'invalid' });
// 正しく選べば approved
expect(await confirmNumber(db, c4, s4, n4)).toEqual({ ok: true });
expect((await getRequesterScreen(db, c4, 'd1')).state).toBe('approved');
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装（乱数は `crypto.randomInt`） → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(api): add cross-device QR confirmation with number matching`

---

### Task 7: 復旧コードと復旧申請

**Files:**
- Create: `packages/shared/src/recovery-code.ts`, `packages/shared/test/recovery-code.test.ts`
- Create: `apps/api/src/auth/recovery.ts`, `apps/api/test/recovery.test.ts`
- Modify: `apps/api/src/http/app.ts`

**Interfaces:**
- Produces:
  - `RECOVERY_ALPHABET: readonly string[]`：次の 4 グループを合わせたもの（紛らわしい文字を除く）
    - 英大文字：`ABCDEFGHJKLMNPQRSTUVWXYZ`（I, O を除く）
    - 英小文字：`abcdefghijkmnpqrstuvwxyz`（l, o を除く）
    - 数字：`23456789`（0, 1 を除く）
    - 記号：`#$%&+=?@`
    - ひらがな：`あいうえかきくけさしすせたちつてなぬねのはひふほまみむめもやゆよらるれわ`（`へ`/`ヘ`、`り`/`リ`、`こ`/`コ`/`二` など、カタカナや漢字と紛れるものを除く）
    - カタカナ：`アイウエオキクケサシスセソタチツテトナヌネノハフホマミムメモヤユヨラルレワ`（`カ`/`力`、`ロ`/`口`、`ニ`/`二`、`ー`、`エ`/`工` のうち `エ` は残し漢字の `工` を入れない、`タ`/`夕` は `夕` を入れない、`ト`/`卜` は `卜` を入れない、`ハ`/`八` は `八` を入れない）
    - 漢字：`山川空海森林花鳥風雪雲星月火水金土木春夏秋冬朝夜東西南北虫魚犬猫竹石光音`
    - NFKC で形が変わる文字（半角カナ、全角英数）は含めない
  - `generateRecoveryCode(): string`：16 文字。各グループ（英大・英小・数字・記号・かな/カナ・漢字）を最低 1 文字含む。`crypto.randomInt` を使う
  - `normalizeRecoveryInput(raw: string): string`：NFKC、空白とハイフンを除去
  - `hashRecoveryCode(code: string): Promise<string>` / `verifyRecoveryCode(input: string, hash: string): Promise<boolean>`（Argon2id、`memoryCost: 19456, timeCost: 2`）
  - `requestRecovery(db, mailer, input: { email: string; recoveryCode: string }): Promise<{ requestId: string } | { error: 'invalid' }>`：コードが正しければ `recovery_requests` を `pending` で作り、`ADMIN_EMAIL` に申請があったことを通知する（本文にメールアドレスや復旧コードは書かず、申請 ID だけ）。メールアドレスが未登録でもコードが違っても同じ `invalid`。回数制限：同じメールハッシュに 1 時間 5 回
  - `approveRecovery(db, mailer, requestId: string): Promise<{ newRecoveryCode: string }>`：既存のセッション・パスキーをすべて取り消し、新しい復旧コードを発行して古いものを無効化し、本人にメールでログインを案内する。フェーズ 1 では管理画面がないので、`pnpm --filter api admin:approve-recovery <id>` という CLI スクリプトから呼ぶ（フェーズ 5 で管理画面に移す）

- [ ] **Step 1: 失敗するテストを書く**

```ts
const code = generateRecoveryCode();
expect([...code]).toHaveLength(16);
expect([...code].every(ch => RECOVERY_ALPHABET.includes(ch))).toBe(true);
for (const ch of RECOVERY_ALPHABET) expect(ch.normalize('NFKC')).toBe(ch);       // 正規化で変わらない
for (const bad of ['O','0','I','l','1','口','力','ー','二','工','夕','卜','八']) expect(RECOVERY_ALPHABET).not.toContain(bad);
// 各グループを最低1文字含む（1000回生成して全部）
// 全角で入力しても通る
const h = await hashRecoveryCode(code);
expect(await verifyRecoveryCode(toFullWidthAscii(code), h)).toBe(true);
expect(await verifyRecoveryCode(` ${code.slice(0,8)}-${code.slice(8)} `, h)).toBe(true);
expect(await verifyRecoveryCode(code.slice(0, 15) + 'X', h)).toBe(false);
// 申請
expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: 'wrong' })).toEqual({ error: 'invalid' });
const { requestId } = await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: codeOfA });
expect(mail.sentTo(ADMIN)).toBe(true);
expect(mail.lastBodyTo(ADMIN)).not.toContain(codeOfA);
const { newRecoveryCode } = await approveRecovery(db, mail, requestId);
expect(await resolveSession(db, oldTokenOfA)).toBeNull();
expect(await requestRecovery(db, mail, { email: 'a@x.y', recoveryCode: codeOfA })).toEqual({ error: 'invalid' }); // 古いコードは無効
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装 → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: add recovery codes and recovery requests`

---

### Task 8: パスキーとログイン履歴

**Files:**
- Create: `apps/api/src/auth/passkeys.ts`, `apps/api/src/auth/login-history.ts`
- Modify: `apps/api/src/http/app.ts`、Task 5〜7 のログイン成功箇所（`recordLogin` を呼ぶ）
- Test: `apps/api/test/passkeys.test.ts`, `apps/api/test/login-history.test.ts`

**Interfaces:**
- Consumes: `@simplewebauthn/server`、Task 4 のセッション
- Produces:
  - `startPasskeyRegistration(db, accountId): Promise<PublicKeyCredentialCreationOptionsJSON>` / `finishPasskeyRegistration(db, accountId, response): Promise<{ ok: true } | { error: 'invalid' }>`（`userVerification: 'required'`、`residentKey: 'required'`、`rpID` は `RP_ID`）
  - `startPasskeyLogin(db): Promise<PublicKeyCredentialRequestOptionsJSON>`（アカウントを指定しないディスカバラブル方式）/ `finishPasskeyLogin(db, response): Promise<{ accountId: string } | { error: 'invalid' }>`（カウンタが戻っていたら拒否）
  - チャレンジは 5 分有効、1 回きり
  - `recordLogin(db, mailer, input: { accountId; method: 'passkey' | 'email' | 'recovery'; deviceLabel; ip: string }): Promise<void>`：IP は IPv4 なら下 1 オクテット、IPv6 なら下 80 ビットを伏せて `ipPrefix` に保存。その端末（`deviceLabel` ＋ `did` Cookie）で初めてのログインなら、本人に「新しい端末からのログイン」メールを送る
  - `listLoginEvents(db, accountId, limit = 50)`
  - `login_events` の 30 日より古い行を消す `purgeOldLoginEvents(db, now: Date)`（フェーズ 1 では手動スクリプト、フェーズ 2 でジョブ化）
  - HTTP：`/auth/passkey/register/{start,finish}`、`/auth/passkey/login/{start,finish}`、`GET /me/logins`

- [ ] **Step 1: 失敗するテストを書く**（WebAuthn の応答は `@simplewebauthn/server` のテストと同じく、ソフトウェアの認証器で作る。ヘルパー `fakeAuthenticator()` を `test/helpers` に置く）

```ts
// 登録→ログインできる
// 同じ応答の再送（リプレイ）は拒否
// カウンタが減った応答は拒否
// 別アカウントの資格情報では、そのアカウントとしてログインできない
await recordLogin(db, mail, { accountId: a.id, method: 'email', deviceLabel: 'Mac / Safari', ip: '203.0.113.45' });
expect((await listLoginEvents(db, a.id))[0].ipPrefix).toBe('203.0.113.0/24');
expect(mail.sentTo('a@x.y')).toBe(true);           // 初めての端末
mail.clear();
await recordLogin(db, mail, { ...same });
expect(mail.sentTo('a@x.y')).toBe(false);          // 2回目は通知しない
await purgeOldLoginEvents(db, addDays(now, 31));
expect(await listLoginEvents(db, a.id)).toHaveLength(0);
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装 → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(api): add passkeys and login history`

---

### Task 9: チームのデータ構造と API

**Files:**
- Create: `packages/shared/src/team-rules.ts`, `apps/api/src/teams/teams.ts`
- Modify: `apps/api/src/http/app.ts`
- Test: `apps/api/test/teams.test.ts`

**Interfaces:**
- Produces:
  - `TEAM_MAX_MEMBERS = 10`、`type TeamRole = 'owner' | 'admin' | 'member'`、`can(role: TeamRole, action: 'invite' | 'remove' | 'changeRole' | 'deleteTeam' | 'transferOwner' | 'deploy'): boolean`
  - `createTeam(db, accountId, name): Promise<{ teamId: string; ownerId: string }>`（作った人が `owner`、`owners` に `kind='team'` の行を作る）
  - `ensureAccountOwner(db, accountId): Promise<string>`（個人用の `owners` 行。登録時に呼ぶ）
  - `inviteMember(db, mailer, teamId, byAccountId, email): Promise<{ inviteId } | { error: 'forbidden' | 'full' }>`、`acceptInvite(db, inviteId, accountId)`（`team_invites` テーブルを追加。招待は 7 日有効、メールの照合は `emailHash`）
  - `changeRole(db, teamId, byAccountId, targetAccountId, role: 'admin' | 'member')`、`removeMember(...)`、`leaveTeam(db, teamId, accountId)`、`transferOwnership(db, teamId, fromAccountId, toAccountId)`
  - エラーは `{ error: 'forbidden' | 'full' | 'last_owner' | 'not_member' }`
  - HTTP：`/teams` 以下に CRUD

- [ ] **Step 1: 失敗するテストを書く**

```ts
const { teamId } = await createTeam(db, a.id, '写真部');
// 10人まで入れる、11人目は full（招待の時点と受諾の時点の両方で確認）
// member は招待できない（forbidden）、admin はできる
// オーナーは脱退できない（last_owner）、オーナーを member に変えられない
// transferOwnership 後：旧オーナーは admin、新オーナーは owner、owner はちょうど1人
expect(await countOwners(db, teamId)).toBe(1);
// メンバーでない人への譲渡は not_member
// 期限切れ（8日後）の招待は受諾できない
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装（役割の変更と譲渡はトランザクションで行い、「オーナーは 1 人」を DB の部分 UNIQUE インデックス `team_members(teamId) WHERE role='owner'` でも保証する） → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat: add teams with roles and ownership transfer`

---

### Task 10: Row Level Security

**Files:**
- Create: `apps/api/src/db/migrations/<n>_rls.sql`（手書きの SQL マイグレーション）
- Modify: `apps/api/src/db/client.ts`
- Test: `apps/api/test/rls.test.ts`

**Interfaces:**
- Produces:
  - DB のロールを 2 つにする：`platform_migrator`（マイグレーション用）と `platform_api`（API が使う。`BYPASSRLS` なし）
  - `withAccount<T>(db, accountId: string, fn: (tx) => Promise<T>): Promise<T>`：トランザクション内で `SET LOCAL app.account_id = $1` してから `fn` を実行する
  - ポリシー：`sessions`、`passkeys`、`login_events` は `account_id = current_setting('app.account_id')::uuid` の行だけ読み書きできる。`team_members` と `teams` は、自分がメンバーであるチームの行だけ読める
  - 認証前の処理（`email_challenges`、ログイン時の `passkeys` の照合など）は、`SECURITY DEFINER` の SQL 関数経由にする

- [ ] **Step 1: 失敗するテストを書く**

```ts
await withAccount(db, a.id, async tx => {
  expect(await tx.select().from(sessions)).toSatisfyAll(s => s.accountId === a.id);
  expect(await tx.select().from(loginEvents).where(eq(loginEvents.accountId, b.id))).toHaveLength(0);
  expect(await tx.select().from(teams).where(eq(teams.id, teamOfBOnly))).toHaveLength(0);
});
// app.account_id を設定しないと 0 行
expect(await apiDb.select().from(sessions)).toHaveLength(0);
```

- [ ] **Step 2:** FAIL → **Step 3:** 実装し、Task 4〜9 のサービス関数が `withAccount` を通るように直す → **Step 4:** `pnpm --filter api test` 全体が PASS
- [ ] **Step 5:** Commit `feat(api): enforce row level security`

---

### Task 11: Web 画面（日英）

**Files:**
- Create: `apps/web/`（Next.js App Router）
  - `app/[locale]/(auth)/login/page.tsx`、`signup/page.tsx`、`login/link/page.tsx`、`login/confirm/page.tsx`、`recover/page.tsx`
  - `app/[locale]/(app)/settings/devices/page.tsx`、`settings/logins/page.tsx`、`settings/passkeys/page.tsx`、`teams/page.tsx`、`teams/[id]/page.tsx`
  - `lib/api.ts`（API クライアント。Cookie はブラウザ任せ、API の URL は `NEXT_PUBLIC_API_ORIGIN`）
  - `middleware.ts`（`Accept-Language` から `/ja` か `/en` へ振り分け）
- Test: `apps/web/e2e/login.spec.ts`（Playwright）

**Interfaces:**
- Consumes: Task 5〜9 の HTTP API、`t()`
- Produces: 画面のみ（後のタスクから参照されない）

画面の決まり：

- パスワード入力欄を一切作らない
- 登録画面：メール → コード → 表示名・生年月日・言語 → **復旧コードを 1 回だけ表示**（「保存しました」にチェックしないと次へ進めない。コピーと印刷のボタン）
- ログイン画面：「パスキーでログイン」と「メールでログイン」。メールでは、リンクを待つあいだ `getRequesterScreen` を 2 秒ごとに呼び、`awaiting_scan` なら QR コード（`qrcode` パッケージ）と数字を表示する
- 確認画面（`login/confirm`）：3 つの数字ボタンと、要求元の端末・地域を表示
- 登録後、パスキーの登録を案内する

- [ ] **Step 1: 失敗する E2E テストを書く**（Mailpit の API `http://localhost:8025/api/v1/messages` から最新メールを読む）

```ts
test('登録してメールでログインできる（日本語）', ...)   // 復旧コードが表示され、チェック前は次へ進めない
test('English UI', ...)                                   // /en で英語の文言が出る
test('別の端末でリンクを開くと QR と数字が出て、正しい数字でログインできる', ...) // 2つの browser context で再現
test('間違った数字を選ぶとログインできない', ...)
test('端末一覧から他の端末をログアウトできる', ...)
test('ページにパスワード入力欄がない', async ({ page }) => {
  for (const path of ['/ja/login', '/ja/signup', '/ja/recover'])
    { await page.goto(path); await expect(page.locator('input[type=password]')).toHaveCount(0); }
});
```

- [ ] **Step 2:** Run: `pnpm --filter web e2e` → FAIL
- [ ] **Step 3:** 画面を実装する
- [ ] **Step 4:** Run 同上 → PASS
- [ ] **Step 5:** Commit `feat(web): add login, signup, recovery, devices and teams screens`

---

### Task 12: CI と仕上げ

**Files:**
- Create: `.github/workflows/ci.yml`、`.gitleaks.toml`、`renovate.json`
- Modify: `README.md`、`docs/dev-setup.md`

- [ ] **Step 1:** CI を書く：`ubuntu-latest` と `macos-latest` の両方で `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm test`（PostgreSQL と Mailpit は `ubuntu` ではサービスコンテナ、`macos` では単体テストのみ）→ `ubuntu` で E2E。加えて gitleaks（秘密情報の混入）と `pnpm audit --audit-level=high`。アクションはコミット SHA で固定する
- [ ] **Step 2:** `renovate.json`：依存はバージョン固定、更新はまとめて週 1 回の PR
- [ ] **Step 3:** ローカルで最終確認。Run: `pnpm dev:down --purge && pnpm dev:up && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web e2e`。Expected: すべて成功
- [ ] **Step 4:** Commit `ci: add CI with lint, tests, e2e and secret scanning`

---

## フェーズ 1 でやらないこと（後のフェーズ）

- アプリ・デプロイ・k3d クラスタへの実際の配置（フェーズ 2〜3）
- 管理画面と Tailscale（フェーズ 5。復旧の承認はそれまで CLI スクリプト）
- VPN の判定（フェーズ 6）
- 個人情報 DB の分離と KMS（フェーズ 5。フェーズ 1 の鍵は開発用の環境変数）
- ジョブキュー（フェーズ 2。ログイン履歴の削除はそれまで手動スクリプト）
