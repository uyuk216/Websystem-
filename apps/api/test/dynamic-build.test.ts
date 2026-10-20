import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createStorage, loadStorageConfig, type Storage } from 'platform';
import { makeZip } from '../../../packages/platform/test/ingest/helpers.js';
import { withTestDb, type TestDb } from './helpers/db.js';
import { accounts, apps, deployments } from '../src/db/schema.js';
import { ensureAccountOwner } from '../src/teams/teams.js';
import { giveStudent } from './helpers/grants.js';
import { createApp } from '../src/apps/apps.js';
import { createDeployment } from '../src/apps/deployments.js';
import { deleteAppStorage, processDeployment } from '../src/ingest/publish.js';

const env = {
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
};
let storage: Storage;
beforeAll(async () => { storage = createStorage(loadStorageConfig(env)); await storage.ensureBuckets(); });
afterAll(() => storage.close());

let n = 0;
const queue = { send: async () => 'job' };
const zip = (files: Record<string, string>) => Readable.from([makeZip(Object.entries(files).map(([name, d]) => ({ name, data: Buffer.from(d) })))]);
const images: string[] = [];
afterAll(() => { for (const t of images) { try { execFileSync('docker', ['image', 'rm', '-f', t], { stdio: 'ignore' }); } catch { /* gone */ } } });

async function deploy(db: TestDb, files: Record<string, string>) {
  const [a] = await db.insert(accounts).values({ emailHash: `dyn${n++}`, emailEnc: 'e', displayName: 'A', locale: 'ja', adultFrom: '2030-01' }).returning();
  const ownerId = await ensureAccountOwner(db, a!.id);
  await giveStudent(db, a!.id);
  const { appId } = await createApp(db, a!.id, { name: `d-${randomUUID().slice(0, 8)}`, ownerId }) as { appId: string };
  await db.update(apps).set({ kind: 'dynamic' }).where(eq(apps.id, appId));
  const r = await createDeployment(db, storage, queue, a!.id, appId, { source: 'upload', archive: zip(files), format: 'zip' });
  if ('error' in r) throw new Error(r.error);
  images.push(`ys/${appId}:${r.deploymentId}`);
  await processDeployment(db, storage, r.deploymentId);
  const d = (await db.select().from(deployments).where(eq(deployments.id, r.deploymentId)))[0]!;
  return { appId, d };
}

describe('dynamic deployment build', () => {
  it('builds a node app, stores the build log and marks the deployment built', () => withTestDb(async (db) => {
    const { appId, d } = await deploy(db, {
      'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }),
      's.js': 'require("http").createServer((q,r)=>r.end("x")).listen(process.env.PORT||8080)',
    });
    expect(d).toMatchObject({ status: 'built', imageRef: `ys/${appId}:${d.id}`, buildLogKey: `${appId}/${d.id}.build.log` });
    expect(await text((await storage.sources.get(d.buildLogKey!))!.body)).toContain('npm install');
    execFileSync('docker', ['image', 'inspect', d.imageRef!], { stdio: 'ignore' });
    await deleteAppStorage(storage, appId);
  }), 240_000);

  it('fails with a build error and keeps the log', () => withTestDb(async (db) => {
    const { appId, d } = await deploy(db, { Dockerfile: 'FROM alpine:3.20\nRUN echo fail-marker && exit 1\n' });
    expect(d).toMatchObject({ status: 'failed', message: 'deploy.error.build_failed', imageRef: null });
    expect(() => execFileSync('docker', ['image', 'inspect', `ys/${appId}:${d.id}`], { stdio: 'ignore' })).toThrow();
    expect(await text((await storage.sources.get(d.buildLogKey!))!.body)).toContain('fail-marker');
    await deleteAppStorage(storage, appId);
  }), 120_000);

  it('fails with unknown_stack when nothing can be detected', () => withTestDb(async (db) => {
    const { appId, d } = await deploy(db, { 'readme.txt': 'hi' });
    expect(d).toMatchObject({ status: 'failed', message: 'deploy.error.unknown_stack' });
    await deleteAppStorage(storage, appId);
  }));

  it('still blocks secrets before building', () => withTestDb(async (db) => {
    const { appId, d } = await deploy(db, { Dockerfile: 'FROM alpine:3.20\n', '.env.prod': 'x', 'k.txt': '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n' });
    expect(d.status).toBe('blocked_secret');
    expect(d.imageRef).toBeNull();
    await deleteAppStorage(storage, appId);
  }));
});
