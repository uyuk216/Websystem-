export interface Config {
  databaseUrl: string;
  emailEncKey: Buffer;
  emailHashKey: Buffer;
  /** AES-256-GCM key for app environment variables (APP_ENV_KEY); env-var routes are disabled when unset. */
  appEnvKey?: Buffer;
  appOrigin: string;
  smtpUrl: string;
  mailFrom: string;
  adminEmail: string;
  rpId: string;
  port: number;
  trustedProxyHops: number;
  /** Dev/e2e only: lower archive size limit in bytes (UPLOAD_MAX_BYTES). Unset = the plan limit. */
  uploadMaxBytes?: number;
  /** Sign-in/sign-up mails per client IP per 10 minutes (AUTH_START_LIMIT, default 20; raised only for E2E). */
  authStartLimit?: number;
  /** Origin of the dedicated student-ID upload page (UPLOAD_ORIGIN, default http://localhost:5174). */
  uploadOrigin: string;
  /** Shared secret for the upload intake's token-consume call (INGEST_SHARED_SECRET, >= 32 chars); the internal route is absent when unset. */
  ingestSharedSecret?: string;
  /** Port / bind address of the separate admin API (never the public app). Bind to the Tailscale interface or loopback behind `tailscale serve`. */
  adminApiPort: number;
  adminBind: string;
  /** Origin the operators' browsers use for the admin UI (WebAuthn expected origin). */
  adminOrigin: string;
  /** Requests must come from a Tailscale address with a matching Tailscale-User-Login. Always true in production. */
  tailscaleRequired: boolean;
  /** Dev only (ADMIN_DEV_TAILSCALE=1): also accept 127.0.0.1 / ::1 as a Tailscale source. Refused at startup in production. */
  adminDevTailscale: boolean;
  /** GitHub App settings; present only when all three GITHUB_* variables are set. */
  github?: { appId: string; privateKey: string; webhookSecret: string; clientId: string; clientSecret: string };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function key32(env: NodeJS.ProcessEnv, name: string): Buffer {
  const buf = Buffer.from(required(env, name), 'base64');
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (base64)`);
  return buf;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3001;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > 65535) throw new Error('PORT must be an integer 1-65535');
  return n;
}

export function parseHops(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw) || Number(raw) > 10) throw new Error('TRUSTED_PROXY_HOPS must be an integer 0-10');
  return Number(raw);
}

function loadGithub(env: NodeJS.ProcessEnv): Config['github'] {
  const { GITHUB_APP_ID: appId, GITHUB_APP_PRIVATE_KEY: key, GITHUB_WEBHOOK_SECRET: webhookSecret, GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = env;
  if (!appId || !key || !webhookSecret || !clientId || !clientSecret) return undefined;
  // PEM keys are often stored in env files with literal "\n".
  return { appId, privateKey: key.replace(/\\n/g, '\n'), webhookSecret, clientId, clientSecret };
}

function loadIngestSecret(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.INGEST_SHARED_SECRET;
  if (!v) return undefined;
  if (v.length < 32) throw new Error('INGEST_SHARED_SECRET must be at least 32 characters');
  return v;
}

function loadAdmin(env: NodeJS.ProcessEnv): Pick<Config, 'adminApiPort' | 'adminBind' | 'adminOrigin' | 'tailscaleRequired' | 'adminDevTailscale'> {
  const production = env.NODE_ENV === 'production';
  const adminDevTailscale = env.ADMIN_DEV_TAILSCALE === '1';
  const tailscaleRequired = env.ADMIN_TAILSCALE_REQUIRED !== '0';
  // The relaxations exist for local development only; a production start with either set is a misconfiguration.
  if (production && (adminDevTailscale || !tailscaleRequired)) {
    throw new Error('ADMIN_DEV_TAILSCALE / ADMIN_TAILSCALE_REQUIRED=0 are not allowed when NODE_ENV=production');
  }
  const port = env.ADMIN_API_PORT;
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw new Error('ADMIN_API_PORT must be an integer 1-65535');
  return {
    adminApiPort: port ? Number(port) : 3002,
    adminBind: env.ADMIN_BIND || '127.0.0.1',
    adminOrigin: env.ADMIN_ORIGIN || 'http://localhost:5175',
    tailscaleRequired,
    adminDevTailscale,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    emailEncKey: key32(env, 'EMAIL_ENC_KEY'),
    emailHashKey: key32(env, 'EMAIL_HASH_KEY'),
    appEnvKey: env.APP_ENV_KEY ? key32(env, 'APP_ENV_KEY') : undefined,
    appOrigin: required(env, 'APP_ORIGIN'),
    smtpUrl: required(env, 'SMTP_URL'),
    mailFrom: env.MAIL_FROM || 'no-reply@localhost',
    adminEmail: required(env, 'ADMIN_EMAIL'),
    rpId: required(env, 'RP_ID'),
    port: parsePort(env.PORT),
    trustedProxyHops: parseHops(env.TRUSTED_PROXY_HOPS),
    uploadMaxBytes: env.UPLOAD_MAX_BYTES && /^\d+$/.test(env.UPLOAD_MAX_BYTES) ? Number(env.UPLOAD_MAX_BYTES) : undefined,
    authStartLimit: env.AUTH_START_LIMIT && /^\d+$/.test(env.AUTH_START_LIMIT) ? Number(env.AUTH_START_LIMIT) : undefined,
    uploadOrigin: env.UPLOAD_ORIGIN || 'http://localhost:5174',
    ingestSharedSecret: loadIngestSecret(env),
    ...loadAdmin(env),
    github: loadGithub(env),
  };
}
