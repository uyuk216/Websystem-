import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (n === 'node_modules' ? [] : statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

describe('the upload origin holds the least privilege it needs', () => {
  const sources = files(root).filter((f) => /\.(ts|json)$/.test(f) && !f.endsWith('isolation.test.ts'));

  it('never touches the admin role or the owner connection of the PII database', () => {
    const hits = sources.filter((f) => /PII_ADMIN|PII_OWNER|pii_admin|pii_owner/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });

  it('never reads the main database or the session cookies (it only calls the API with the shared secret)', () => {
    const hits = sources.filter((f) => /DATABASE_URL(?!.*PII_INGEST)|\bsid\b|drizzle|from 'api'/.test(readFileSync(f, 'utf8').replace(/PII_INGEST_DATABASE_URL/g, ''))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });

  it('loads no third-party script or font anywhere in its sources', () => {
    const hits = sources.filter((f) => f.endsWith('.ts') && /https?:\/\/(?!127\.0\.0\.1|localhost|upload\.invalid)[a-z0-9.-]+/i.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))).map((f) => relative(root, f));
    expect(hits).toEqual([]);
  });
});
