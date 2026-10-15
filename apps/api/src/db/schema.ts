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
