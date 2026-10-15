import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ZipFile } from 'yazl';

export interface FileEntry {
  /** POSIX-style path relative to the deploy root. */
  rel: string;
  abs: string;
  size: number;
}

/** Never uploaded, whatever .gitignore says. Compared case-insensitively against each path segment. */
export function isAlwaysExcluded(name: string): boolean {
  const n = name.toLowerCase();
  return n === '.env' || n.startsWith('.env.') || n === '.git' || n === '.ds_store' || n === 'node_modules';
}

/** Walks `root`, skipping always-excluded names, symlinks and anything ignored by the root or nested .gitignore files. */
export async function collectFiles(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const walk = async (dirAbs: string, dirRel: string, matchers: { base: string; ig: Ignore }[]): Promise<void> => {
    let local = matchers;
    try {
      const gi = await readFile(join(dirAbs, '.gitignore'), 'utf8');
      local = [...matchers, { base: dirRel, ig: ignore().add(gi) }];
    } catch { /* no .gitignore here */ }
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const e of entries) {
      if (isAlwaysExcluded(e.name) || e.isSymbolicLink()) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      const ignored = local.some((m) => {
        const sub = m.base ? rel.slice(m.base.length + 1) : rel;
        return m.ig.ignores(isDir ? `${sub}/` : sub);
      });
      if (ignored) continue;
      const abs = join(dirAbs, e.name);
      if (isDir) await walk(abs, rel, local);
      else if (e.isFile()) out.push({ rel, abs, size: (await lstat(abs)).size });
    }
  };
  await walk(root, '', []);
  return out;
}

export function buildZip(files: FileEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const f of files) zip.addFile(f.abs, f.rel);
    zip.end();
  });
}
