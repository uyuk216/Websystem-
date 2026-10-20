import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const SELF = 'test/pii-isolation.test.ts';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP_DIRS.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('apps/api cannot reach the PII database (Review Focus 1)', () => {
  it('no PII connection setting appears anywhere under apps/api (code, config, migrations, package.json)', () => {
    const hits = files(apiRoot)
      .filter((f) => relative(apiRoot, f) !== SELF && relative(apiRoot, f) !== 'drizzle-pii/0000_init.sql')
      .filter((f) => /PII_(OWNER_|ADMIN_|INGEST_)?DATABASE_URL|piiDatabaseUrl|ys-pii-db|ys-piinet|pii_admin|pii_ingest|packages\/platform\/src\/pii|createPiiPool/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(apiRoot, f));
    expect(hits).toEqual([]);
  });

  it('the shared dev env file loaded by the API holds no PII setting; they live in a separate file', () => {
    for (const f of ['.env.development.example', '.env.development']) {
      let text = '';
      try { text = readFileSync(join(repoRoot, f), 'utf8'); } catch { continue; }
      expect(text).not.toMatch(/PII_|ys-pii/i);
    }
    const pkg = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const cmd of Object.values(pkg.scripts)) expect(cmd).not.toMatch(/pii/i);
  });

  it('loadConfig neither reads nor exposes a PII url, even if one is in the environment', () => {
    const env = {
      DATABASE_URL: 'postgres://x', EMAIL_ENC_KEY: Buffer.alloc(32).toString('base64'), EMAIL_HASH_KEY: Buffer.alloc(32).toString('base64'),
      APP_ORIGIN: 'http://localhost', SMTP_URL: 'smtp://localhost', ADMIN_EMAIL: 'a@example.com', RP_ID: 'localhost',
      PII_DATABASE_URL: 'postgres://pii:secret@127.0.0.1:54321/pii', PII_ADMIN_DATABASE_URL: 'postgres://pii:secret@127.0.0.1:54321/pii',
    };
    const cfg = loadConfig(env);
    expect(JSON.stringify(cfg, (_k, v) => (Buffer.isBuffer(v) ? '<buf>' : v))).not.toMatch(/pii|secret|54321/i);
    expect(Object.keys(cfg).some((k) => /pii/i.test(k))).toBe(false);
  });
});
