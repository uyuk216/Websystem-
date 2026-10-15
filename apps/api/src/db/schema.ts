import { sql } from 'drizzle-orm';
import {
  bigint, check, customType, index, integer, pgTable, primaryKey, text, timestamp, uuid,
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
  createdAt: createdAt(),
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
  teamId: uuid('team_id').notNull().references(() => teams.id),
  accountId: uuid('account_id').notNull().references(() => accounts.id),
  role: text('role').notNull(),
}, (t) => [primaryKey({ columns: [t.teamId, t.accountId] })]);

export const owners = pgTable('owners', {
  id: id(),
  kind: text('kind', { enum: ['account', 'team'] }).notNull(),
  accountId: uuid('account_id').references(() => accounts.id),
  teamId: uuid('team_id').references(() => teams.id),
}, (t) => [
  check('owners_kind_ref_check', sql`(
    (${t.kind} = 'account' AND ${t.accountId} IS NOT NULL AND ${t.teamId} IS NULL) OR
    (${t.kind} = 'team' AND ${t.teamId} IS NOT NULL AND ${t.accountId} IS NULL)
  )`),
]);
