import { resolve } from 'node:path';
import { buildZip, collectFiles } from './archive.js';

export interface Out {
  log: (line: string) => void;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

interface Base {
  api: string;
  token: string;
  fetch?: typeof fetch;
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const url = (api: string, path: string) => api.replace(/\/+$/, '') + path;

async function getJson<T>(b: Base, path: string): Promise<T> {
  const res = await (b.fetch ?? fetch)(url(b.api, path), { method: 'GET', headers: headers(b.token) });
  if (res.status === 401) throw new Error('Not authorized. Run `yourservice login` with a valid API token.');
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return await res.json() as T;
}

export async function listApps(b: Base): Promise<{ id: string; name: string }[]> {
  return (await getJson<{ apps: { id: string; name: string }[] }>(b, '/apps')).apps;
}

export async function deploy(o: Base & { dir: string; app: string; out: Out }): Promise<{ deploymentId: string; fileCount: number }> {
  const f = o.fetch ?? fetch;
  const app = (await listApps(o)).find((a) => a.name === o.app);
  if (!app) throw new Error(`App "${o.app}" not found.`);
  const files = await collectFiles(resolve(o.dir));
  if (files.length === 0) throw new Error('No files to deploy.');
  const total = files.reduce((n, x) => n + x.size, 0);
  o.out.log(`${files.length} file${files.length === 1 ? '' : 's'}, ${formatSize(total)} total`);
  const zip = await buildZip(files);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), 'site.zip');
  const res = await f(url(o.api, `/apps/${app.id}/deployments`), { method: 'POST', headers: headers(o.token), body: form });
  const body = await res.json().catch(() => ({})) as { deploymentId?: string; error?: string };
  if (!res.ok || !body.deploymentId) throw new Error(`Upload failed: ${body.error ?? res.status}`);
  o.out.log(`Deployment ${body.deploymentId} queued.`);
  return { deploymentId: body.deploymentId, fileCount: files.length };
}
