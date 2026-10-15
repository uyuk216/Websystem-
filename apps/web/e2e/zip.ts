import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yazl from 'yazl';

/** Builds a ZIP in a temp dir from path -> content and returns its file path. */
export async function makeZip(files: Record<string, string>, name = 'site.zip'): Promise<string> {
  const zip = new yazl.ZipFile();
  for (const [p, c] of Object.entries(files)) zip.addBuffer(Buffer.from(c), p);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const ch of zip.outputStream) chunks.push(ch as Buffer);
  const path = join(mkdtempSync(join(tmpdir(), 'e2e-zip-')), name);
  writeFileSync(path, Buffer.concat(chunks));
  return path;
}
