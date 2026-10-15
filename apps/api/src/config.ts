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
  };
}
