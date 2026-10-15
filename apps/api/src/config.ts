export interface Config {
  databaseUrl: string;
  emailEncKey: Buffer;
  emailHashKey: Buffer;
  appOrigin: string;
  smtpUrl: string;
  mailFrom: string;
  adminEmail: string;
  rpId: string;
  port: number;
  trustedProxyHops: number;
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

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    emailEncKey: key32(env, 'EMAIL_ENC_KEY'),
    emailHashKey: key32(env, 'EMAIL_HASH_KEY'),
    appOrigin: required(env, 'APP_ORIGIN'),
    smtpUrl: required(env, 'SMTP_URL'),
    mailFrom: env.MAIL_FROM || 'no-reply@localhost',
    adminEmail: required(env, 'ADMIN_EMAIL'),
    rpId: required(env, 'RP_ID'),
    port: parsePort(env.PORT),
    trustedProxyHops: parseHops(env.TRUSTED_PROXY_HOPS),
    github: loadGithub(env),
  };
}
