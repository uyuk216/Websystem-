import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import yauzl from 'yauzl';

export type ArchiveFormat = 'zip' | 'tar.gz';
export type ArchiveLimits = {
  /** max total bytes of kept (non-excluded) files */
  maxTotalBytes: number;
  maxFileBytes: number;
  /** max entries in the archive (default 20,000) */
  maxEntries?: number;
  /** max compressed upload size spooled to disk (default maxTotalBytes) */
  maxArchiveBytes?: number;
  /** max bytes streamed through excluded tar entries (default 10x maxTotalBytes) */
  maxExcludedBytes?: number;
};
export type FileEntry = { path: string; size: number };
export type ArchiveErrorCode = 'too_large' | 'file_too_large' | 'unsafe_path' | 'symlink' | 'corrupt';
export type InspectResult =
  | { files: FileEntry[]; excluded: string[]; totalBytes: number }
  | { error: ArchiveErrorCode };
export type ExtractedEntry = { path: string; size: number; open(): Readable };

export const DEFAULT_MAX_ENTRIES = 20_000;

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveErrorCode) {
    super(code);
  }
}

/** Normalizes an entry name or throws unsafe_path. Returns null for the root dir. */
export function normalizeEntryPath(raw: string): string | null {
  if (raw.includes('\0') || raw.includes('\\')) throw new ArchiveError('unsafe_path');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new ArchiveError('unsafe_path');
  const parts: string[] = [];
  for (const seg of raw.normalize('NFC').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new ArchiveError('unsafe_path');
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** Always-excluded: .env, .env.*, .git/, .DS_Store, node_modules/ */
export function isExcluded(path: string): boolean {
  return path.split('/').some((seg) => {
    const s = seg.toLowerCase();
    return s === '.git' || s === 'node_modules' || s === '.ds_store' || s === '.env' || s.startsWith('.env.');
  });
}

const EXEC_EXT = new Set(['exe', 'apk', 'dmg', 'msi', 'app', 'deb', 'rpm', 'bat', 'sh', 'jar']);

export function findExecutables(paths: string[]): string[] {
  return paths.filter((p) =>
    p
      .toLowerCase()
      .split('/')
      .some((seg) => {
        const i = seg.lastIndexOf('.');
        return i > 0 && EXEC_EXT.has(seg.slice(i + 1));
      }),
  );
}

class Counter extends Transform {
  n = 0;
  constructor(private readonly max: number, private readonly onExceed: () => Error) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.n += chunk.length;
    if (this.n > this.max) cb(this.onExceed());
    else {
      this.push(chunk);
      cb();
    }
  }
}

async function spool(input: Readable, maxBytes: number, dir: string): Promise<string> {
  const file = join(dir, 'upload');
  const limiter = new Counter(maxBytes, () => new ArchiveError('too_large'));
  await pipeline(input, limiter, createWriteStream(file));
  return file;
}

function toArchiveError(e: unknown): ArchiveError {
  return e instanceof ArchiveError ? e : new ArchiveError('corrupt');
}

type Raw = { path: string; declared: number; excluded: boolean; open(): Readable };

async function* zipEntries(file: string, limits: Required<ArchiveLimits>): AsyncGenerator<Raw> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (e, z) =>
      e ? rej(new ArchiveError('corrupt')) : res(z),
    ),
  );
  try {
    let count = 0;
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((res, rej) => {
        const onEntry = (en: yauzl.Entry) => { cleanup(); res(en); };
        const onEnd = () => { cleanup(); res(null); };
        const onErr = () => { cleanup(); rej(new ArchiveError('corrupt')); };
        const cleanup = () => {
          zip.off('entry', onEntry); zip.off('end', onEnd); zip.off('error', onErr);
        };
        zip.on('entry', onEntry); zip.on('end', onEnd); zip.on('error', onErr);
        zip.readEntry();
      });
      if (!entry) return;
      if (++count > limits.maxEntries) throw new ArchiveError('too_large');
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const madeByUnix = entry.versionMadeBy >>> 8 === 3;
      if (madeByUnix && mode === 0o120000) throw new ArchiveError('symlink');
      const fileName = Buffer.isBuffer(entry.fileName) ? (entry.fileName as Buffer).toString('utf8') : entry.fileName;
      const path = normalizeEntryPath(fileName);
      if (fileName.endsWith('/')) continue;
      if (path === null) continue;
      if (entry.isEncrypted()) throw new ArchiveError('corrupt');
      yield {
        path,
        declared: entry.uncompressedSize,
        excluded: isExcluded(path),
        open: () => {
          const out = new PassThrough();
          zip.openReadStream(entry, (err, rs) => {
            if (err || !rs) return out.destroy(new ArchiveError('corrupt'));
            rs.on('error', (e) => out.destroy(toArchiveError(e)));
            rs.pipe(out);
          });
          return out;
        },
      };
    }
  } finally {
    zip.close();
  }
}

async function* tarEntries(file: string, limits: Required<ArchiveLimits>): AsyncGenerator<Raw> {
  type Item = { entry?: tar.ReadEntry; done?: boolean; error?: Error };
  const queue: Item[] = [];
  let wake: (() => void) | null = null;
  const push = (i: Item) => { queue.push(i); wake?.(); wake = null; };
  const parser = new tar.Parser({ strict: true });
  parser.on('entry', (entry: tar.ReadEntry) => { entry.pause(); push({ entry }); });
  parser.on('error', (e: Error) => push({ error: e }));
  parser.on('end', () => push({ done: true }));
  const src = createReadStream(file);
  const gunzip = createGunzip();
  // Caps ALL decompressed tar bytes (kept, excluded and dropped-type bodies alike).
  const cap = new Counter(limits.maxTotalBytes + limits.maxExcludedBytes, () => new ArchiveError('too_large'));
  src.on('error', (e) => push({ error: e }));
  gunzip.on('error', (e) => push({ error: e }));
  cap.on('error', (e) => push({ error: e }));
  src.pipe(gunzip).pipe(cap).pipe(parser);
  let prev: tar.ReadEntry | undefined;
  let count = 0;
  try {
    for (;;) {
      if (prev) { prev.resume(); prev = undefined; }
      while (!queue.length) await new Promise<void>((r) => (wake = r));
      const item = queue.shift()!;
      if (item.error) throw toArchiveError(item.error);
      if (item.done) return;
      const entry = item.entry!;
      prev = entry;
      if (++count > limits.maxEntries) throw new ArchiveError('too_large');
      const type = entry.type as string;
      if (type === 'SymbolicLink' || type === 'Link') throw new ArchiveError('symlink');
      const path = normalizeEntryPath(entry.header.path ?? entry.path);
      if (type !== 'File' && type !== 'OldFile' && type !== 'ContiguousFile') {
        continue; // directories and special types (devices, fifos, pax headers) are dropped
      }
      if (path === null) continue;
      yield { path, declared: entry.size ?? 0, excluded: isExcluded(path), open: () => entry as unknown as Readable };
    }
  } finally {
    src.destroy();
    gunzip.destroy();
    cap.destroy();
  }
}

function withDefaults(l: ArchiveLimits): Required<ArchiveLimits> {
  return {
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxArchiveBytes: l.maxTotalBytes,
    maxExcludedBytes: l.maxTotalBytes * 10,
    ...l,
  };
}

async function* rawEntries(dir: string, input: Readable, format: ArchiveFormat, limits: Required<ArchiveLimits>) {
  let file: string;
  try {
    file = await spool(input, limits.maxArchiveBytes, dir);
  } catch (e) {
    throw toArchiveError(e);
  }
  const files = new Set<string>();
  const dirs = new Set<string>();
  const src = format === 'zip' ? zipEntries(file, limits) : tarEntries(file, limits);
  for await (const e of src) {
    const key = e.path.normalize('NFC').toLowerCase();
    if (files.has(key) || dirs.has(key)) throw new ArchiveError('unsafe_path');
    const segs = key.split('/');
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      if (files.has(prefix)) throw new ArchiveError('unsafe_path');
      dirs.add(prefix);
    }
    files.add(key);
    yield e;
  }
}

/** Drains `s`, throwing if actual bytes exceed `max`. Returns actual count. */
async function drain(s: Readable, max: number, over: ArchiveErrorCode): Promise<number> {
  const c = new Counter(max, () => new ArchiveError(over));
  try {
    await pipeline(s, c, new Writable({ write: (_c, _e, cb) => cb() }));
  } catch (e) {
    throw toArchiveError(e);
  }
  return c.n;
}

/**
 * Validates the whole archive, streaming and counting real decompressed bytes
 * (declared sizes are not trusted). Excluded files are reported, not stored.
 */
export async function inspectArchive(
  input: Readable,
  format: ArchiveFormat,
  limitsIn: ArchiveLimits,
): Promise<InspectResult> {
  const limits = withDefaults(limitsIn);
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  try {
    const files: FileEntry[] = [];
    const excluded: string[] = [];
    let total = 0;
    let excludedBytes = 0;
    for await (const e of rawEntries(dir, input, format, limits)) {
      if (e.excluded) {
        excluded.push(e.path);
        if (format === 'tar.gz') {
          excludedBytes += await drain(e.open(), limits.maxExcludedBytes - excludedBytes, 'too_large');
        }
        continue;
      }
      if (e.declared > limits.maxFileBytes) throw new ArchiveError('file_too_large');
      if (total + e.declared > limits.maxTotalBytes) throw new ArchiveError('too_large');
      const actual = await drain(e.open(), limits.maxFileBytes, 'file_too_large');
      total += actual;
      if (total > limits.maxTotalBytes) throw new ArchiveError('too_large');
      files.push({ path: e.path, size: actual });
    }
    return { files, excluded, totalBytes: total };
  } catch (e) {
    return { error: toArchiveError(e).code };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Yields kept (non-excluded) files. Each open() stream must be consumed before
 * advancing; it errors if real bytes exceed the limits. Throws ArchiveError.
 * Collision/duplicate checks and byte counting are enforced here independently
 * of inspectArchive. Callers MUST iterate with for-await to completion or call
 * return(); that runs the finally block which removes the temp directory.
 */
export async function* extractArchive(
  input: Readable,
  format: ArchiveFormat,
  limitsIn: ArchiveLimits,
): AsyncGenerator<ExtractedEntry> {
  const limits = withDefaults(limitsIn);
  const dir = await mkdtemp(join(tmpdir(), 'ingest-'));
  try {
    let total = 0;
    let pending = 0; // declared size of an entry whose stream was not fully consumed
    for await (const e of rawEntries(dir, input, format, limits)) {
      total += pending;
      pending = 0;
      if (e.excluded) continue;
      if (e.declared > limits.maxFileBytes) throw new ArchiveError('file_too_large');
      if (total + e.declared > limits.maxTotalBytes) throw new ArchiveError('too_large');
      const budget = Math.min(limits.maxFileBytes, limits.maxTotalBytes - total);
      const counter = new Counter(budget, () =>
        new ArchiveError(budget === limits.maxFileBytes ? 'file_too_large' : 'too_large'),
      );
      const open = () => e.open().on('error', (er) => counter.destroy(er)).pipe(counter);
      pending = e.declared;
      yield {
        path: e.path,
        size: e.declared,
        open: () => {
          const s = open();
          s.on('end', () => {
            total += counter.n; // actual bytes, not declared
            pending = 0;
          });
          return s;
        },
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
