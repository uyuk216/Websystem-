import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptEmail, encryptEmail, hashEmail, normalizeEmail } from '../src/crypto/email.js';
import { loadConfig } from '../src/config.js';

const k = randomBytes(32);
const tamper = (b: string) => {
  const buf = Buffer.from(b, 'base64');
  buf[buf.length - 1] = buf[buf.length - 1]! ^ 1;
  return buf.toString('base64');
};

describe('email crypto', () => {
  it('normalizes', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
    expect(normalizeEmail('ｆｏｏ＠example.com')).toBe('foo@example.com');
  });
  it('hashes normalized form deterministically', () => {
    expect(hashEmail('foo@example.com', k)).toBe(hashEmail(normalizeEmail('FOO@example.com'), k));
    expect(hashEmail('foo@example.com', k)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('encrypts and decrypts', () => {
    const blob = encryptEmail('foo@example.com', k);
    expect(blob).not.toContain('foo');
    expect(decryptEmail(blob, k)).toBe('foo@example.com');
    expect(encryptEmail('foo@example.com', k)).not.toBe(blob);
    expect(() => decryptEmail(tamper(blob), k)).toThrow();
  });
});

describe('loadConfig', () => {
  const valid = {
    DATABASE_URL: 'postgres://x', EMAIL_ENC_KEY: randomBytes(32).toString('base64'),
    EMAIL_HASH_KEY: randomBytes(32).toString('base64'), APP_ORIGIN: 'http://localhost:5173',
    SMTP_URL: 'smtp://localhost:1025', ADMIN_EMAIL: 'a@example.com', RP_ID: 'localhost',
  };
  it('throws when missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('rejects wrong key length', () => {
    expect(() => loadConfig({ ...valid, EMAIL_ENC_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/EMAIL_ENC_KEY/);
  });
  it('rejects invalid PORT', () => {
    for (const p of ['0', '65536', 'abc', '1.5', '-1']) expect(() => loadConfig({ ...valid, PORT: p })).toThrow(/PORT/);
    expect(loadConfig({ ...valid, PORT: '8080' }).port).toBe(8080);
  });
  it('parses valid env', () => {
    const c = loadConfig(valid);
    expect(c.emailEncKey.length).toBe(32);
    expect(c.port).toBe(3001);
  });
});
