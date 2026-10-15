import { randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appPrefix, createStorage, loadStorageConfig, type Storage } from '../src/index.js';

const cfg = loadStorageConfig({
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'minioadmin',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'minioadmin',
});
let storage: Storage;
beforeAll(async () => {
  storage = createStorage(cfg);
  await storage.ensureBuckets();
});
afterAll(() => storage.close());

describe('storage', () => {
  it('ensureBuckets is idempotent', async () => {
    await storage.ensureBuckets();
    await storage.ensureBuckets();
  });

  it('round-trips put/get/head/list/deletePrefix', async () => {
    const p = `t-${randomUUID()}/`;
    await storage.sites.put(`${p}index.html`, '<h1>hi</h1>', 'text/html');
    await storage.sites.put(`${p}a/b.txt`, Buffer.from('bee'));
    const got = await storage.sites.get(`${p}index.html`);
    expect(got?.contentType).toBe('text/html');
    expect(got?.size).toBe(11);
    expect(await text(got!.body)).toBe('<h1>hi</h1>');
    expect(await storage.sites.head(`${p}a/b.txt`)).toMatchObject({ size: 3 });
    expect((await storage.sites.list(p)).map((o) => o.key).sort()).toEqual([`${p}a/b.txt`, `${p}index.html`]);
    expect(await storage.sites.deletePrefix(p)).toBe(2);
    expect(await storage.sites.list(p)).toEqual([]);
    expect(await storage.sites.get(`${p}index.html`)).toBeNull();
    expect(await storage.sites.head(`${p}index.html`)).toBeNull();
  });

  it('keeps buckets separate and refuses an empty prefix', async () => {
    const k = `t-${randomUUID()}/x`;
    await storage.sources.put(k, 'x');
    expect(await storage.sites.head(k)).toBeNull();
    await expect(storage.sources.deletePrefix('')).rejects.toThrow();
    await storage.sources.deletePrefix(`${k}`.replace(/x$/, ''));
  });

  it('deletePrefix requires a trailing slash and does not touch sibling ids', async () => {
    const a = randomUUID();
    const b = a.slice(0, 35) + (a.endsWith('0') ? '1' : '0');
    await storage.sites.put(`${a}/i.html`, 'a');
    await storage.sites.put(`${b}/i.html`, 'b');
    await expect(storage.sites.deletePrefix(a)).rejects.toThrow();
    await expect(storage.sites.deletePrefix(a.slice(0, 20))).rejects.toThrow();
    expect(await storage.sites.deletePrefix(appPrefix('sites', a))).toBe(1);
    expect(await storage.sites.head(`${b}/i.html`)).not.toBeNull();
    await storage.sites.deletePrefix(appPrefix('sites', b));
    expect(() => appPrefix('sites', 'ab')).toThrow();
    expect(() => appPrefix('sites', '../x')).toThrow();
  });

  it('puts large streams (multipart)', async () => {
    const { Readable } = await import('node:stream');
    const k = `t-${randomUUID()}/big`;
    const chunk = Buffer.alloc(1024 * 1024, 7);
    await storage.sources.put(k, Readable.from(Array.from({ length: 12 }, () => chunk)));
    expect((await storage.sources.head(k))?.size).toBe(12 * 1024 * 1024);
    await storage.sources.deletePrefix(k.replace(/big$/, ''));
  });

  it('puts streams', async () => {
    const { Readable } = await import('node:stream');
    const k = `t-${randomUUID()}/s`;
    await storage.sources.put(k, Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(await text((await storage.sources.get(k))!.body)).toBe('abcd');
    await storage.sources.deletePrefix(k.replace(/s$/, ''));
  });
});
