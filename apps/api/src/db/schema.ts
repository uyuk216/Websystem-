import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const id = () => uuid('id').primaryKey().default(sql`gen_random_uuid()`);

export const accounts = pgTable('accounts', {
  id: id(),
  emailHash: text('email_hash').notNull().unique(),
  emailEnc: text('email_enc').notNull(),
  displayName: text('display_name').notNull(),
  locale: text('locale').notNull(),
  adultFrom: text('adult_from').notNull(),
  recoveryCodeHash: text('recovery_code_hash'),
  createdAt: createdAt(),
}, (t) => [
  check('accounts_adult_from_format_check', sql`${t.adultFrom} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
]);

export const sessions = pgTable('sessions', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  tokenHash: text('token_hash').notNull().unique(),
  deviceLabel: text('device_label').notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const apiTokens = pgTable('api_tokens', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const emailChallenges = pgTable('email_challenges', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id),
  emailHash: text('email_hash').notNull(),
  purpose: text('purpose', { enum: ['login', 'signup'] }).notNull(),
  codeHash: text('code_hash').notNull(),
  linkTokenHash: text('link_token_hash').notNull(),
  requesterDeviceId: text('requester_device_id').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  crossDeviceNumber: integer('cross_device_number'),
  crossDeviceState: text('cross_device_state'),
  scanToken: text('scan_token'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  requesterDeviceLabel: text('requester_device_label'),
  /** SHA-256 hex of the `did` of the device that opened the mailed link; only that device may confirm the number. */
  openerDeviceKey: text('opener_device_key'),
});

export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  publicKey: bytea('public_key').notNull(),
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: text('transports').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const loginEvents = pgTable('login_events', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  method: text('method', { enum: ['passkey', 'email', 'recovery'] }).notNull(),
  deviceLabel: text('device_label').notNull(),
  region: text('region'),
  ipPrefix: text('ip_prefix').notNull(),
  /** SHA-256 hex of the `did` device cookie; used to detect a first login from a device. */
  deviceKey: text('device_key').notNull(),
  createdAt: createdAt(),
}, (t) => [index('login_events_account_device_idx').on(t.accountId, t.deviceKey)]);

export const webauthnChallenges = pgTable('webauthn_challenges', {
  id: id(),
  accountId: uuid('account_id').references(() => accounts.id),
  challenge: text('challenge').notNull(),
  kind: text('kind', { enum: ['register', 'login'] }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export const recoveryRequests = pgTable('recovery_requests', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  createdAt: createdAt(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

export const recoveryAttempts = pgTable('recovery_attempts', {
  id: id(),
  emailHash: text('email_hash').notNull(),
  createdAt: createdAt(),
}, (t) => [index('recovery_attempts_email_hash_created_at_idx').on(t.emailHash, t.createdAt)]);

export const teams = pgTable('teams', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  role: text('role').notNull(),
}, (t) => [
  primaryKey({ columns: [t.teamId, t.accountId] }),
  // Exactly one owner per team, guaranteed by the database.
  uniqueIndex('team_members_one_owner_idx').on(t.teamId).where(sql`${t.role} = 'owner'`),
]);

export const teamInvites = pgTable('team_invites', {
  id: id(),
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  emailHash: text('email_hash').notNull(),
  /** SHA-256 hex of the mailed token; the token itself is never stored. */
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull().references(() => accounts.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('team_invites_team_idx').on(t.teamId)]);

export const owners = pgTable('owners', {
  id: id(),
  kind: text('kind', { enum: ['account', 'team'] }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id),
  teamId: uuid('team_id').references(() => teams.id),
}, (t) => [
  uniqueIndex('owners_account_idx').on(t.accountId),
  uniqueIndex('owners_team_idx').on(t.teamId),
  check('owners_kind_ref_check', sql`(
    (${t.kind} = 'account' AND ${t.accountId} IS NOT NULL AND ${t.teamId} IS NULL) OR
    (${t.kind} = 'team' AND ${t.teamId} IS NOT NULL AND ${t.accountId} IS NULL)
  )`),
]);

export const apps = pgTable('apps', {
  id: id(),
  ownerId: uuid('owner_id').notNull().references(() => owners.id),
  name: text('name').notNull().unique(),
  kind: text('kind', { enum: ['static', 'dynamic'] }).notNull().default('static'),
  publishDir: text('publish_dir').notNull().default(''),
  activeDeploymentId: uuid('active_deployment_id'),
  /** Set by rollback: deployments created before this moment may no longer go live. */
  rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
  /** Dynamic apps: last proxied request (written by the edge at most once a minute); drives sleep. */
  lastAccessAt: timestamp('last_access_at', { withTimezone: true }),
  githubRepo: text('github_repo'),
  githubBranch: text('github_branch'),
  githubInstallationId: text('github_installation_id'),
  createdAt: createdAt(),
}, (t) => [index('apps_owner_idx').on(t.ownerId)]);

export const deployments = pgTable('deployments', {
  id: id(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  source: text('source', { enum: ['upload', 'cli', 'github'] }).notNull(),
  status: text('status', {
    enum: ['queued', 'processing', 'live', 'superseded', 'failed', 'blocked_secret', 'held_for_review', 'built'],
  }).notNull().default('queued'),
  sourceKey: text('source_key').notNull(),
  siteKey: text('site_key'),
  /** Dynamic apps: image built for this deployment (`ys/<appId>:<deploymentId>`). */
  imageRef: text('image_ref'),
  /** Dynamic apps: key of the build log in the sources bucket. */
  buildLogKey: text('build_log_key'),
  totalBytes: bigint('total_bytes', { mode: 'number' }),
  fileCount: integer('file_count'),
  message: text('message'),
  findings: jsonb('findings'),
  commitSha: text('commit_sha'),
  createdBy: uuid('created_by').references(() => accounts.id),
  createdAt: createdAt(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  index('deployments_app_idx').on(t.appId, t.createdAt),
  // A commit is deployed at most once while it is queued, processing or live (atomic webhook dedupe).
  uniqueIndex('deployments_app_commit_active_idx').on(t.appId, t.commitSha)
    .where(sql`${t.commitSha} is not null and ${t.status} in ('queued', 'processing', 'live', 'built')`),
]);

/** Per-app monthly transfer (UTC month 'YYYY-MM'). Written only by the static server (owner role). */
export const transferUsage = pgTable('transfer_usage', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  month: text('month').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  notified80: boolean('notified_80').notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.appId, t.month] }),
  check('transfer_usage_month_format_check', sql`${t.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
]);

/** Installations an account proved access to through GitHub user authorization (OAuth). */
export const githubInstallationLinks = pgTable('github_installation_links', {
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  installationId: text('installation_id').notNull(),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.accountId, t.installationId] })]);

/** Pending OAuth authorizations: hash of the state nonce, bound to the starting session. Owner role only. */
export const githubOauthStates = pgTable('github_oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [index('github_oauth_states_expires_idx').on(t.expiresAt)]);

/** Webhook delivery ids already handled (replay protection). Owner role only. */
export const githubDeliveries = pgTable('github_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appEnvVars = pgTable('app_env_vars', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** base64(iv | tag | ciphertext), AES-256-GCM with appId+name as associated data. */
  valueEnc: text('value_enc').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.appId, t.name] })]);

/** One row per app per minute with containers running (dedupe key for runtime metering). Written only by the metering job. */
export const runtimeMinutes = pgTable('runtime_minutes', {
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  minute: timestamp('minute', { withTimezone: true }).notNull(),
  containers: integer('containers').notNull(),
}, (t) => [primaryKey({ columns: [t.appId, t.minute] })]);

/** Container-minutes per owner and period ('YYYY-MM' in JST, or 'FY<start year>'). Written only by the metering job. */
export const runtimeUsage = pgTable('runtime_usage', {
  ownerId: uuid('owner_id').notNull().references(() => owners.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  minutes: bigint('minutes', { mode: 'number' }).notNull().default(0),
  notified80: boolean('notified_80').notNull().default(false),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.period] }),
  check('runtime_usage_period_format_check', sql`${t.period} ~ '^([0-9]{4}-(0[1-9]|1[0-2])|FY[0-9]{4})$'`),
]);

/** One row per request served by the edge (static and dynamic). IP is masked; kept 30 days; written only by the edge (system). */
export const accessLogs = pgTable('access_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  status: integer('status').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull().default(0),
  uaKind: text('ua_kind').notNull(),
  referrer: text('referrer'),
  ipPrefix: text('ip_prefix').notNull(),
}, (t) => [index('access_logs_app_created_idx').on(t.appId, t.createdAt.desc()), index('access_logs_created_idx').on(t.createdAt)]);

/** One user database per dynamic app (phase 4). The password is encrypted like env vars; never returned by the API. */
export const appDatabases = pgTable('app_databases', {
  appId: uuid('app_id').primaryKey().references(() => apps.id, { onDelete: 'cascade' }),
  /** creating | ready | failed */
  status: text('status').notNull().default('creating'),
  passwordEnc: text('password_enc').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  /** normal | read_only | blocked (see DatabaseWriteMode) */
  writeMode: text('write_mode').notNull().default('normal'),
  /** Highest usage level already mailed this month (0, 80 or 100) and the month it applies to (YYYY-MM). */
  notifiedLevel: integer('notified_level').notNull().default(0),
  notifiedMonth: text('notified_month'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Student verification requests (phase 5). Holds no image data: ciphertext lives only in the separate PII database. */
export const studentVerifications = pgTable('student_verifications', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  status: text('status', { enum: ['pending', 'approved', 'rejected', 'expired'] }).notNull().default('pending'),
  schoolName: text('school_name').notNull(),
  schoolKind: text('school_kind').notNull(),
  expectedGraduationYear: integer('expected_graduation_year').notNull(),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  createdAt: createdAt(),
}, (t) => [
  index('student_verifications_account_idx').on(t.accountId, t.createdAt),
  check('student_verifications_school_name_check', sql`char_length(${t.schoolName}) between 1 and 100`),
]);

/**
 * One row per submission attempt; `id` is the uploadId shared with the PII database (no foreign key across databases).
 * The one-shot submission token is stored as a hash only. `blob_ref` is set when the token is consumed by the intake.
 */
export const verificationUploads = pgTable('verification_uploads', {
  id: id(),
  verificationId: uuid('verification_id').notNull().references(() => studentVerifications.id, { onDelete: 'cascade' }),
  blobRef: text('blob_ref'),
  tokenHash: text('token_hash').notNull().unique(),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
  tokenUsedAt: timestamp('token_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [index('verification_uploads_verification_idx').on(t.verificationId)]);

/** Operators (phase 5). Admin tables are unreachable from platform_api; only platform_admin (via withAdmin) touches them. */
export const operators = pgTable('operators', {
  accountId: uuid('account_id').primaryKey().references(() => accounts.id),
  /** Lower-cased Tailscale login that `tailscale serve` puts in Tailscale-User-Login. */
  tailscaleLogin: text('tailscale_login').notNull().unique(),
  role: text('role', { enum: ['reviewer', 'owner'] }).notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

/** Elevated (passkey-verified) admin sessions: 30 minutes, token stored as a hash. */
export const adminSessions = pgTable('admin_sessions', {
  id: id(),
  operatorId: uuid('operator_id').notNull().references(() => operators.accountId),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('admin_sessions_operator_idx').on(t.operatorId)]);

/**
 * Append-only operator action log. UPDATE/DELETE/TRUNCATE are rejected by triggers; `seq`, `prev_hash` and `hash`
 * are assigned by a BEFORE INSERT trigger (hash chain, verified by admin_audit_verify()).
 */
export const adminAuditLog = pgTable('admin_audit_log', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  operatorId: uuid('operator_id').notNull().references(() => operators.accountId),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  prevHash: text('prev_hash').notNull().default(''),
  hash: text('hash').notNull().default(''),
});

/** Platform-wide tunables (limits etc.), editable only from the admin side. */
export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').notNull().references(() => operators.accountId),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Dangerous operations are booked 24 hours ahead, can be cancelled, and notify the owners. */
export const scheduledDangerousActions = pgTable('scheduled_dangerous_actions', {
  id: id(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
  requestedBy: uuid('requested_by').notNull().references(() => operators.accountId),
  executeAfter: timestamp('execute_after', { withTimezone: true }).notNull(),
  status: text('status', { enum: ['scheduled', 'executed', 'cancelled'] }).notNull().default('scheduled'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('scheduled_dangerous_actions_due_idx').on(t.status, t.executeAfter)]);

/**
 * 付与（Grant、フェーズ 5）。Student / Starter / イベントブーストの「いまの権利」を表す。プランは付与から計算する（grants/entitlements.ts）。
 * 読めるのは本人（自分のアカウント・自分が使えるオーナー・見えるアプリ宛て）だけ。書き込みはシステム（owner ロール）と管理側（platform_admin）だけ。
 */
export const grants = pgTable('grants', {
  id: id(),
  targetKind: text('target_kind', { enum: ['account', 'owner', 'app'] }).notNull(),
  targetId: uuid('target_id').notNull(),
  kind: text('kind', { enum: ['student', 'starter', 'event_boost'] }).notNull(),
  params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** 停止する日（Student は有効期限 3/31 の次の 5/1）。 */
  suspendOn: timestamp('suspend_on', { withTimezone: true }),
  reason: text('reason').notNull().default(''),
  /** 運営者のアカウント ID か 'system'。 */
  approvedBy: text('approved_by').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('grants_target_idx').on(t.targetKind, t.targetId),
  // Starter は 1 人 1 回（取り消した後も再付与しない）。Student は同じ対象に有効なものを 1 つだけ（再登録は期限の更新）。
  uniqueIndex('grants_starter_once_idx').on(t.targetId).where(sql`${t.kind} = 'starter'`),
  uniqueIndex('grants_student_active_idx').on(t.targetKind, t.targetId).where(sql`${t.kind} = 'student' AND ${t.revokedAt} IS NULL`),
  check('grants_period_check', sql`${t.endsAt} > ${t.startsAt}`),
]);

/**
 * オーナーごとの利用の状態（フェーズ 5 Task 7）。変えるのは `transitionUsageState` だけ。
 * `reasons` は理由の集合（優先順位 凍結 > ブロック > 停止 > 猶予 > 有効 で `state` が決まる）。
 * 認証の有効期限（`valid_until` = 3/31）と停止する日（`suspend_on` = 5/1）は別々の列。
 */
export const usageStates = pgTable('usage_states', {
  ownerId: uuid('owner_id').primaryKey().references(() => owners.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['active', 'grace', 'suspended', 'blocked', 'frozen'] }).notNull().default('active'),
  reasons: text('reasons').array().notNull().default(sql`'{}'::text[]`),
  /** フェーズ 7 の予約: 有料になったオーナーには時間の理由が付かない。 */
  paid: boolean('paid').notNull().default(false),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  suspendOn: timestamp('suspend_on', { withTimezone: true }),
  nextEvaluateAt: timestamp('next_evaluate_at', { withTimezone: true }),
  /** 再登録の案内メールを送った年度（'FY2026'）。年度ごとに 1 回だけ。 */
  reregNotifiedFor: text('rereg_notified_for'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('usage_states_next_idx').on(t.nextEvaluateAt)]);

/**
 * Starter Grant の申請（フェーズ 5 Task 8）。1 人につき進行中（pending / approved）は 1 件だけ（部分一意索引）。
 * 利用者は自分の申請を読める・pending で作れるだけ。承認・差し戻しはシステム側（owner）と管理側だけ。
 */
export const starterApplications = pgTable('starter_applications', {
  id: id(),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  project: text('project').notNull(),
  githubLogin: text('github_login').notNull(),
  introduction: text('introduction').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'rejected'] }).notNull().default('pending'),
  /** 申請時に確認した GitHub アカウントの作成日。 */
  githubCreatedAt: timestamp('github_created_at', { withTimezone: true }).notNull(),
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  grantId: uuid('grant_id'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('starter_applications_live_idx').on(t.accountId).where(sql`${t.status} IN ('pending', 'approved')`),
  check('starter_applications_lengths_check', sql`char_length(${t.project}) between 1 and 1000 AND char_length(${t.githubLogin}) between 1 and 39 AND char_length(${t.introduction}) between 1 and 2000`),
]);

/** SMS 認証済みの電話番号の HMAC ハッシュ（重複確認だけに使う。番号そのものはどこにも保存しない）。owner ロールだけ。 */
export const smsHashes = pgTable('sms_hashes', {
  hash: text('hash').primaryKey(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [index('sms_hashes_account_idx').on(t.accountId)]);

/** Starter の終了予告を送った記録（付与ごと・種類ごとに 1 回）。owner ロールだけ。 */
export const starterNotices = pgTable('starter_notices', {
  grantId: uuid('grant_id').notNull().references(() => grants.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['d14', 'd3'] }).notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.grantId, t.kind] })]);

/**
 * イベントブーストの申請（フェーズ 5 Task 9）。アプリ単位。承認すると `grants`（kind = event_boost、target = app）ができ、
 * 期間中だけ `resolveEntitlements(owner, at, { appId })` が転送量・メモリ・スリープを上乗せする。
 * `applied_at` / `restored_at` はワーカーがコンテナを作り直した印（期間の頭と終わりに 1 回ずつ）。
 */
export const eventBoosts = pgTable('event_boosts', {
  id: id(),
  appId: uuid('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  ownerId: uuid('owner_id').notNull().references(() => owners.id, { onDelete: 'cascade' }),
  requestedBy: uuid('requested_by').notNull().references(() => accounts.id),
  eventName: text('event_name').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  expectedVisits: integer('expected_visits').notNull(),
  status: text('status', { enum: ['requested', 'approved', 'rejected'] }).notNull().default('requested'),
  extraTransferBytes: bigint('extra_transfer_bytes', { mode: 'number' }),
  extraMemoryMb: integer('extra_memory_mb'),
  grantId: uuid('grant_id'),
  rejectReason: text('reject_reason'),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  restoredAt: timestamp('restored_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('event_boosts_app_idx').on(t.appId, t.startsAt),
  index('event_boosts_status_idx').on(t.status, t.endsAt),
  check('event_boosts_period_check', sql`${t.endsAt} > ${t.startsAt}`),
  check('event_boosts_name_check', sql`char_length(${t.eventName}) between 1 and 100 AND ${t.expectedVisits} >= 0`),
]);

/**
 * セキュリティ事件（フェーズ 6 Task 1）。作るのは `handleSecuritySignal` だけ。証拠は許可リストのキーだけで、
 * 本文・環境変数・生の IP は入らない。IP は HMAC（`ip_hash`）。(source, source_event_id) で重複を排除する。
 */
export const securityIncidents = pgTable('security_incidents', {
  id: id(),
  source: text('source').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  ruleVersion: text('rule_version').notNull(),
  severity: text('severity', { enum: ['low', 'medium', 'high'] }).notNull(),
  targetKind: text('target_kind', { enum: ['app', 'account', 'ip'] }).notNull(),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  ipHash: text('ip_hash'),
  reasonCode: text('reason_code').notNull(),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  evidenceDigest: text('evidence_digest').notNull(),
  status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('security_incidents_source_event_idx').on(t.source, t.sourceEventId),
  index('security_incidents_app_idx').on(t.appId),
  check('security_incidents_target_check', sql`(
    (${t.targetKind} = 'app' AND ${t.appId} IS NOT NULL AND ${t.accountId} IS NULL AND ${t.ipHash} IS NULL) OR
    (${t.targetKind} = 'account' AND ${t.accountId} IS NOT NULL AND ${t.appId} IS NULL AND ${t.ipHash} IS NULL) OR
    (${t.targetKind} = 'ip' AND ${t.ipHash} IS NOT NULL AND ${t.appId} IS NULL AND ${t.accountId} IS NULL)
  )`),
]);

/**
 * 有効なブロック理由（`released_at` が null のもの）。アプリ・アカウント・IP の対象ごと、理由ごとに 1 行。
 * 解除は対象の理由だけで、データ・DB・イメージは消さない。オーナーの `usage_states` とは別管理。
 */
export const securityBlocks = pgTable('security_blocks', {
  id: id(),
  incidentId: uuid('incident_id').notNull().references(() => securityIncidents.id, { onDelete: 'cascade' }),
  targetKind: text('target_kind', { enum: ['app', 'account', 'ip'] }).notNull(),
  appId: uuid('app_id').references(() => apps.id, { onDelete: 'cascade' }),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
  ipHash: text('ip_hash'),
  reasonCode: text('reason_code').notNull(),
  createdAt: createdAt(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedBy: uuid('released_by').references(() => operators.accountId),
  releaseNote: text('release_note'),
}, (t) => [
  uniqueIndex('security_blocks_active_idx').on(t.incidentId, t.reasonCode).where(sql`${t.releasedAt} IS NULL`),
  index('security_blocks_app_idx').on(t.appId).where(sql`${t.releasedAt} IS NULL`),
  index('security_blocks_ip_idx').on(t.ipHash).where(sql`${t.releasedAt} IS NULL`),
  check('security_blocks_target_check', sql`(
    (${t.targetKind} = 'app' AND ${t.appId} IS NOT NULL AND ${t.accountId} IS NULL AND ${t.ipHash} IS NULL) OR
    (${t.targetKind} = 'account' AND ${t.accountId} IS NOT NULL AND ${t.appId} IS NULL AND ${t.ipHash} IS NULL) OR
    (${t.targetKind} = 'ip' AND ${t.ipHash} IS NOT NULL AND ${t.appId} IS NULL AND ${t.accountId} IS NULL)
  )`),
]);

/** 耐久 outbox。コンテナ停止・通知・Object Lock 配送を事件と同じ transaction で積み、worker が再試行する。 */
export const securityOutbox = pgTable('security_outbox', {
  id: id(),
  incidentId: uuid('incident_id').notNull().references(() => securityIncidents.id, { onDelete: 'cascade' }),
  priority: integer('priority').notNull().default(0),
  kind: text('kind', { enum: ['stop_app', 'notify_operator', 'notify_owner', 'deliver_audit'] }).notNull(),
  /** 副作用の一意キー。同じ副作用を二重に積まない。 */
  effectKey: text('effect_key').notNull().unique(),
  payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  doneAt: timestamp('done_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  createdAt: createdAt(),
}, (t) => [index('security_outbox_due_idx').on(t.nextAttemptAt).where(sql`${t.doneAt} IS NULL`)]);

/**
 * 自動対処のシステム用監査連鎖（運営者の `admin_audit_log` とは別）。追記専用で、seq / prev_hash / hash はトリガーが決める。
 * アカウントとの対応は持たない（匿名の事件 ID・操作・時刻・理由コード・ハッシュだけ）。
 */
export const securityAudit = pgTable('security_audit', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  incidentId: uuid('incident_id').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail').notNull().default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  prevHash: text('prev_hash').notNull().default(''),
  hash: text('hash').notNull().default(''),
});

/** Private recovery records; accessed only through authenticated security services. */
export const securityAppeals = pgTable('security_appeals', {
  id: id(), incidentId: uuid('incident_id').notNull().references(() => securityIncidents.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  message: text('message').notNull(), createdAt: createdAt(),
});
export const securityNotifications = pgTable('security_notifications', {
  id: id(), accountId: uuid('account_id').notNull().references(() => accounts.id),
  incidentId: uuid('incident_id').notNull().references(() => securityIncidents.id),
  effectKey: text('effect_key').notNull().unique(), audience: text('audience').notNull(),
  subject: text('subject').notNull(), body: text('body').notNull(),
  mailedAt: timestamp('mailed_at', { withTimezone: true }), createdAt: createdAt(),
});
