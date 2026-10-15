import {
  extractArchive, findExecutables, scanSecrets, MAX_SCAN_BYTES,
  type ArchiveFormat, type Finding, type Storage,
} from 'platform';
import { STATIC_LIMITS } from 'shared';

export const LIMITS = { maxTotalBytes: STATIC_LIMITS.storageBytes, maxFileBytes: STATIC_LIMITS.fileBytes } as const;

/** Resolves an archive path against publishDir. Null when the entry lies outside the publish folder. */
export function relativeToPublishDir(path: string, publishDir: string): string | null {
  if (publishDir === '') return path;
  const prefix = `${publishDir}/`;
  return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null;
}

/** GitHub tarballs wrap everything in `<owner>-<repo>-<sha>/`; drops that first segment (null for entries outside it). */
function stripTopDir(path: string): string | null {
  const i = path.indexOf('/');
  return i > 0 && i < path.length - 1 ? path.slice(i + 1) : null;
}

/** Path of an archive entry as the site sees it, before publishDir is applied. */
export const entryPath = (path: string, stripTop: boolean): string | null => (stripTop ? stripTopDir(path) : path);

export type Outcome =
  | { kind: 'ready'; files: number; bytes: number }
  | { kind: 'blocked'; findings: Finding[] }
  | { kind: 'held' }
  | { kind: 'failed'; message: string };

/** Pass 1: extract and inspect only. Nothing is written to the sites bucket. */
export async function inspect(storage: Storage, sourceKey: string, format: ArchiveFormat, publishDir: string, stripTop: boolean): Promise<Outcome> {
  const src = await storage.sources.get(sourceKey);
  if (!src) return { kind: 'failed', message: 'deploy.error.source_missing' };
  const findings: Finding[] = [];
  const kept: string[] = [];
  let bytes = 0;
  for await (const e of extractArchive(src.body, format, LIMITS)) {
    // extractArchive already drops always-excluded paths. It sees the full path, so a publishDir such as
    // ".git" or "node_modules/x" leaves nothing to publish.
    const inner = entryPath(e.path, stripTop);
    const rel = inner === null ? null : relativeToPublishDir(inner, publishDir);
    if (rel === null) continue;
    kept.push(rel);
    const chunks: Buffer[] = [];
    let n = 0;
    for await (const c of e.open() as AsyncIterable<Buffer>) {
      if (n <= MAX_SCAN_BYTES) chunks.push(c);
      n += c.length;
    }
    bytes += n;
    if (n <= MAX_SCAN_BYTES) findings.push(...scanSecrets(rel, Buffer.concat(chunks)));
  }
  if (kept.length === 0) return { kind: 'failed', message: 'deploy.error.empty' };
  if (findings.length) return { kind: 'blocked', findings };
  if (findExecutables(kept).length) return { kind: 'held' };
  return { kind: 'ready', files: kept.length, bytes };
}
