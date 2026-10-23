import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export interface Asset {
  /** `/assets/...` */
  path: string;
  body: Uint8Array;
  contentType: string;
}

export interface ClientAssets {
  script: Asset & { integrity: string };
  style: Asset;
}

/** ブラウザ側のスクリプトを 1 本にまとめ、SRI のハッシュ（sha384）を計算する。ファイル名にもハッシュを入れる。 */
export async function buildBrowserScript(entry: string): Promise<Uint8Array> {
  const out = await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, write: false, legalComments: 'none',
    // The bundle must not depend on anything outside the repository's pinned packages and must contain no network origin.
    logLevel: 'silent',
  });
  return out.outputFiles[0]!.contents;
}

export async function buildClientAssets(): Promise<ClientAssets> {
  const js = await buildBrowserScript(fileURLToPath(new URL('./client/submit.ts', import.meta.url)));
  const integrity = `sha384-${createHash('sha384').update(js).digest('base64')}`;
  const name = createHash('sha256').update(js).digest('hex').slice(0, 16);
  const css = await readFile(fileURLToPath(new URL('./styles.css', import.meta.url)));
  return {
    script: { path: `/assets/submit.${name}.js`, body: js, contentType: 'text/javascript; charset=utf-8', integrity },
    style: { path: '/assets/submit.css', body: css, contentType: 'text/css; charset=utf-8' },
  };
}
