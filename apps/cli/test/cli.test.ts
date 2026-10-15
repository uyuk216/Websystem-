import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFiles, buildZip } from '../src/archive.js';
import { configPath, loadConfig, saveConfig, clearConfig } from '../src/config.js';
import { deploy, formatSize, type Out } from '../src/commands.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'ys-cli-'));
const put = (root: string, rel: string, data = 'x') => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, data);
};
/** Central-directory file names of a zip (store/deflate agnostic). */
function zipNames(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(off + 28), m = buf.readUInt16LE(off + 30), k = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + n).toString());
    off += 46 + n + m + k;
  }
  return names.sort();
}

describe('collectFiles', () => {
  it('always excludes .env, .git, .DS_Store, node_modules (case-insensitive) and honors .gitignore', async () => {
    const d = tmp();
    put(d, 'index.html');
    put(d, 'css/a.css');
    put(d, '.env'); put(d, '.ENV.local'); put(d, '.git/config'); put(d, '.GIT/HEAD'); put(d, '.DS_Store');
    put(d, 'sub/.DS_Store'); put(d, 'node_modules/x/i.js'); put(d, 'Node_Modules/y.js'); put(d, 'sub/node_modules/z.js');
    put(d, 'sub/.env.production');
    put(d, '.gitignore', 'secret.txt\nbuild/\n*.log\n');
    put(d, 'secret.txt'); put(d, 'build/o.js'); put(d, 'a.log'); put(d, 'sub/b.log');
    put(d, 'sub/.gitignore', 'only-here.txt\n');
    put(d, 'sub/only-here.txt'); put(d, 'only-here.txt');
    const files = await collectFiles(d);
    expect(files.map((f) => f.rel).sort()).toEqual(['.gitignore', 'css/a.css', 'index.html', 'only-here.txt', 'sub/.gitignore']);
  });
});

describe('buildZip', () => {
  it('builds a zip without excluded files', async () => {
    const d = tmp();
    put(d, 'index.html', '<h1>hi</h1>'); put(d, '.env', 'SECRET=1'); put(d, '.git/config', 'c');
    const files = await collectFiles(d);
    const zip = await buildZip(files);
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    expect(zipNames(zip)).toEqual(['index.html']);
    expect(zip.includes(Buffer.from('SECRET=1'))).toBe(false);
  });
});

describe('config', () => {
  it('respects XDG_CONFIG_HOME, saves 0600, clears', () => {
    const d = tmp();
    const env = { XDG_CONFIG_HOME: d };
    expect(configPath(env)).toBe(join(d, 'yourservice', 'config.json'));
    expect(loadConfig(env)).toBeNull();
    saveConfig(env, { token: 'ysk_abc' });
    expect(statSync(configPath(env)).mode & 0o777).toBe(0o600);
    expect(loadConfig(env)).toEqual({ token: 'ysk_abc' });
    clearConfig(env);
    expect(loadConfig(env)).toBeNull();
  });
});

describe('deploy', () => {
  it('shows size and count, then uploads a zip without .env/.git', async () => {
    const d = tmp();
    put(d, 'index.html', '<h1>hi</h1>'); put(d, '.env', 'SECRET=1'); put(d, '.git/config', 'c');
    const lines: string[] = [];
    const out: Out = { log: (s) => lines.push(s) };
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === 'POST') return new Response(JSON.stringify({ deploymentId: 'dep1' }), { status: 201 });
      return new Response(JSON.stringify({ apps: [{ id: 'app1', name: 'mysite' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await deploy({ api: 'http://api.test', token: 'ysk_t', dir: d, app: 'mysite', fetch: fetchFn, out });
    expect(r).toEqual({ deploymentId: 'dep1', fileCount: 1 });
    expect(lines.join('\n')).toMatch(/1 file/);
    expect(lines.join('\n')).toContain(formatSize(11));
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect(post.url).toBe('http://api.test/apps/app1/deployments');
    expect((post.init.headers as Record<string, string>).authorization).toBe('Bearer ysk_t');
    const file = (post.init.body as FormData).get('file') as File;
    expect(file.name).toMatch(/\.zip$/);
    const buf = Buffer.from(await file.arrayBuffer());
    expect(zipNames(buf)).toEqual(['index.html']);
    expect(buf.includes(Buffer.from('SECRET=1'))).toBe(false);
  });

  it('fails clearly for an unknown app', async () => {
    const d = tmp();
    put(d, 'index.html');
    const fetchFn = (async () => new Response(JSON.stringify({ apps: [] }), { status: 200 })) as unknown as typeof fetch;
    await expect(deploy({ api: 'http://api.test', token: 't', dir: d, app: 'nope', fetch: fetchFn, out: { log() {} } })).rejects.toThrow(/nope/);
  });
});
