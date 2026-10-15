import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { extractArchive, findExecutables, inspectArchive, type ArchiveLimits } from '../../src/ingest/archive.js';
import { makeTarGz, makeZip, stream } from './helpers.js';

const L: ArchiveLimits = { maxTotalBytes: 200 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024 };
const b = (s: string) => Buffer.from(s);

describe.each([
  ['zip', (f: { n: string; d?: Buffer; sym?: boolean }[]) => makeZip(f.map((x) => ({ name: x.n, data: x.d ?? b('x'), symlink: x.sym })))],
  ['tar.gz', (f: { n: string; d?: Buffer; sym?: boolean }[]) =>
    makeTarGz(f.map((x) => ({ path: x.n, data: x.d ?? b('x'), type: x.sym ? 'SymbolicLink' as const : 'File' as const, linkpath: x.sym ? 'target' : undefined })))],
] as const)('inspectArchive %s', (format, build) => {
  const run = (files: Parameters<typeof build>[0], l: ArchiveLimits = L) =>
    inspectArchive(stream(build(files)), format, l);

  it('lists files, normalizes paths, reports totals', async () => {
    const r = await run([{ n: './index.html', d: b('hello') }, { n: 'css//a.css', d: b('ab') }]);
    expect(r).toEqual({ files: [{ path: 'index.html', size: 5 }, { path: 'css/a.css', size: 2 }], excluded: [], totalBytes: 7 });
  });
  it.each(['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b'])('rejects unsafe path %s', async (n) => {
    expect(await run([{ n }])).toEqual({ error: 'unsafe_path' });
  });
  it('rejects symlinks', async () => {
    expect(await run([{ n: 'link', sym: true }])).toEqual({ error: 'symlink' });
  });
  it('excludes .env, .env.*, .git/, node_modules/, .DS_Store', async () => {
    const r = await run([
      { n: 'index.html' }, { n: '.env' }, { n: 'sub/.env.local' }, { n: '.git/config' },
      { n: 'node_modules/x/i.js' }, { n: 'a/.DS_Store' }, { n: '.envrc-not' },
    ]);
    expect(r).toMatchObject({
      files: [{ path: 'index.html', size: 1 }, { path: '.envrc-not', size: 1 }],
      excluded: ['.env', 'sub/.env.local', '.git/config', 'node_modules/x/i.js', 'a/.DS_Store'],
    });
  });
  it('rejects a 26MB single file', async () => {
    expect(await run([{ n: 'big.bin', d: Buffer.alloc(26 * 1024 * 1024, 1) }])).toEqual({ error: 'file_too_large' });
  });
  it('rejects total over limit by declared sizes', async () => {
    const r = await run([{ n: 'a', d: Buffer.alloc(600) }, { n: 'b', d: Buffer.alloc(600) }], { maxTotalBytes: 1000, maxFileBytes: 1000 });
    expect(r).toEqual({ error: 'too_large' });
  });
  it('rejects too many entries', async () => {
    const r = await run([{ n: 'a' }, { n: 'b' }, { n: 'c' }], { ...L, maxEntries: 2 });
    expect(r).toEqual({ error: 'too_large' });
  });
  it('rejects duplicate paths', async () => {
    expect(await run([{ n: 'a' }, { n: './a' }])).toEqual({ error: 'unsafe_path' });
  });
  it('rejects corrupt input', async () => {
    expect(await inspectArchive(stream(b('not an archive')), format, L)).toEqual({ error: 'corrupt' });
  });
  it('rejects compressed upload over maxArchiveBytes', async () => {
    const r = await run([{ n: 'a', d: randomBytes(5000) }], { ...L, maxArchiveBytes: 100 });
    expect(r).toEqual({ error: 'too_large' });
  });
});

describe('zip bombs', () => {
  it('stops on real bytes when the declared size lies (deflated zeros)', async () => {
    const zip = makeZip([{ name: 'bomb', data: Buffer.alloc(20 * 1024 * 1024), deflate: true, declaredSize: 10 }]);
    const r = await inspectArchive(stream(zip), 'zip', { maxTotalBytes: 1024 * 1024, maxFileBytes: 1024 * 1024 });
    expect('error' in r).toBe(true);
  });
  it('stops a highly compressed file by actual size (honest declaration)', async () => {
    const zip = makeZip([{ name: 'bomb', data: Buffer.alloc(8 * 1024 * 1024), deflate: true }]);
    expect(zip.length).toBeLessThan(100_000);
    const r = await inspectArchive(stream(zip), 'zip', { maxTotalBytes: 1024 * 1024, maxFileBytes: 4 * 1024 * 1024 });
    expect(r).toEqual({ error: 'file_too_large' });
  });
  it('rejects total over 200MB of actual data (many compressible files)', async () => {
    const zeros = Buffer.alloc(20 * 1024 * 1024);
    const zip = makeZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: zeros, deflate: true })));
    expect(await inspectArchive(stream(zip), 'zip', L)).toEqual({ error: 'too_large' });
  }, 60_000);
});

describe('tar bombs', () => {
  it('rejects total over limit while streaming', async () => {
    const tgz = makeTarGz([{ path: 'a', data: Buffer.alloc(600) }, { path: 'b', data: Buffer.alloc(600) }]);
    expect(await inspectArchive(stream(tgz), 'tar.gz', { maxTotalBytes: 1000, maxFileBytes: 1000 })).toEqual({ error: 'too_large' });
  });
  it('drops hard links as symlink and ignores directories', async () => {
    const tgz = makeTarGz([{ path: 'd/', type: 'Directory' }, { path: 'h', type: 'Link', linkpath: 'x' }]);
    expect(await inspectArchive(stream(tgz), 'tar.gz', L)).toEqual({ error: 'symlink' });
  });
});

describe('extractArchive', () => {
  it.each(['zip', 'tar.gz'] as const)('yields kept files with readable streams (%s)', async (format) => {
    const buf = format === 'zip'
      ? makeZip([{ name: 'a.txt', data: b('AAA') }, { name: '.env', data: b('S') }, { name: 'b/c.txt', data: b('CC') }])
      : makeTarGz([{ path: 'a.txt', data: b('AAA') }, { path: '.env', data: b('S') }, { path: 'b/c.txt', data: b('CC') }]);
    const out: Record<string, string> = {};
    for await (const e of extractArchive(stream(buf), format, L)) {
      const chunks: Buffer[] = [];
      for await (const c of e.open() as Readable) chunks.push(c as Buffer);
      out[e.path] = Buffer.concat(chunks).toString();
    }
    expect(out).toEqual({ 'a.txt': 'AAA', 'b/c.txt': 'CC' });
  });
  it('errors the stream when real bytes exceed the limit', async () => {
    const zip = makeZip([{ name: 'bomb', data: Buffer.alloc(5 * 1024 * 1024), deflate: true, declaredSize: 10 }]);
    const run = async () => {
      for await (const e of extractArchive(stream(zip), 'zip', { maxTotalBytes: 1 << 20, maxFileBytes: 1 << 20 })) {
        for await (const _ of e.open() as Readable) void _;
      }
    };
    await expect(run()).rejects.toBeTruthy();
  });
});

describe('findExecutables', () => {
  it('detects listed extensions case-insensitively, including .app bundles', () => {
    expect(findExecutables(['a.html', 'setup.EXE', 'x/run.sh', 'My.app/Contents/x', 'a.jar', 'b.apk', 'c.dmg', 'd.msi', 'e.deb', 'f.rpm', 'g.bat', 'sh', 'notexe.txt', 'app']))
      .toEqual(['setup.EXE', 'x/run.sh', 'My.app/Contents/x', 'a.jar', 'b.apk', 'c.dmg', 'd.msi', 'e.deb', 'f.rpm', 'g.bat']);
  });
});
