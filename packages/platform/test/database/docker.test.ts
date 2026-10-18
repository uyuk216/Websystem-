import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { DockerDatabaseDriver, databaseNetwork } from '../../src/database/docker.js';
import { databaseNames, databaseUrl } from '../../src/database/driver.js';

const available = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const driver = new DockerDatabaseDriver();
const ownerId = randomUUID();
const created: string[] = [];

/** Runs psql in a throwaway client container on `network` (the app's side of the connection). */
function psqlFrom(network: string, url: string, sql: string): { ok: boolean; out: string } {
  const r = spawnSync('docker', ['run', '--rm', '--network', network, 'postgres:16-alpine', 'psql', url, '-v', 'ON_ERROR_STOP=1', '-qtAc', sql], { encoding: 'utf8', timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

async function makeDb() {
  const appId = randomUUID();
  created.push(appId);
  const { database, user } = databaseNames(appId);
  const password = randomBytes(24).toString('base64url');
  await driver.create({ appId, ownerId, database, user, password, limits: { connections: 10, memoryMb: 256 } });
  return { appId, database, user, password, url: databaseUrl(driver.endpoint(appId), database, user, password) };
}

afterAll(async () => { await Promise.all(created.map((id) => driver.remove(id))); }, 120_000);

describe.skipIf(!available)('DockerDatabaseDriver', { timeout: 180_000 }, () => {
  it('the app reaches its own database; another app cannot reach it; no host port is published', async () => {
    const a = await makeDb();
    const b = await makeDb();
    expect(await driver.status(a.appId)).toBe('running');
    expect(psqlFrom(databaseNetwork(a.appId), a.url, 'CREATE TABLE t(x int); INSERT INTO t VALUES (1); SELECT count(*) FROM t;')).toEqual({ ok: true, out: '1' });
    // App B sits on its own network: A's server does not even resolve there.
    expect(psqlFrom(databaseNetwork(b.appId), a.url, 'SELECT 1').ok).toBe(false);
    // Even with A's network, B's credentials do not open A's database (and vice versa).
    const crossUrl = databaseUrl(driver.endpoint(a.appId), a.database, b.user, b.password);
    expect(psqlFrom(databaseNetwork(a.appId), crossUrl, 'SELECT 1').ok).toBe(false);
    const ports = execFileSync('docker', ['inspect', '-f', '{{json .NetworkSettings.Ports}}', `ys-db-${a.appId}`], { encoding: 'utf8' });
    expect(ports).not.toMatch(/HostPort/);
    // The internal network has no route out.
    expect(execFileSync('docker', ['network', 'inspect', '-f', '{{.Internal}}', databaseNetwork(a.appId)], { encoding: 'utf8' }).trim()).toBe('true');
  });

  it('is not a superuser, has a connection limit and cannot open other databases', async () => {
    const a = await makeDb();
    const net = databaseNetwork(a.appId);
    expect(psqlFrom(net, a.url, "SELECT rolsuper::text || ',' || rolconnlimit FROM pg_roles WHERE rolname = current_user")).toEqual({ ok: true, out: 'false,10' });
    expect(psqlFrom(net, a.url.replace(`/${a.database}`, '/postgres'), 'SELECT 1').ok).toBe(false);
    expect(psqlFrom(net, a.url, 'CREATE DATABASE other').ok).toBe(false);
  });

  it('read_only stops writes but keeps reads; blocked refuses connections; normal restores writes', async () => {
    const a = await makeDb();
    const net = databaseNetwork(a.appId);
    expect(psqlFrom(net, a.url, 'CREATE TABLE t(x int); INSERT INTO t VALUES (1);').ok).toBe(true);
    expect(await driver.sizeBytes(a.appId, a.database)).toBeGreaterThan(1_000_000);
    await driver.setWriteMode(a.appId, a.database, a.user, 'read_only');
    expect(psqlFrom(net, a.url, 'INSERT INTO t VALUES (2)').out).toMatch(/read-only/);
    expect(psqlFrom(net, a.url, 'SELECT count(*) FROM t')).toEqual({ ok: true, out: '1' });
    await driver.setWriteMode(a.appId, a.database, a.user, 'blocked');
    expect(psqlFrom(net, a.url, 'SELECT 1').ok).toBe(false);
    await driver.setWriteMode(a.appId, a.database, a.user, 'normal');
    expect(psqlFrom(net, a.url, 'INSERT INTO t VALUES (3); SELECT count(*) FROM t;')).toEqual({ ok: true, out: '2' });
  });

  it('restores a backup; a broken dump leaves the current data untouched', async () => {
    const a = await makeDb();
    const net = databaseNetwork(a.appId);
    psqlFrom(net, a.url, "CREATE TABLE notes(body text); INSERT INTO notes VALUES ('before');");
    const chunks: Buffer[] = [];
    for await (const c of await driver.backup(a.appId, a.database)) chunks.push(c as Buffer);
    const dump = Buffer.concat(chunks);
    expect(dump.length).toBeGreaterThan(100);
    psqlFrom(net, a.url, "DELETE FROM notes; INSERT INTO notes VALUES ('after');");

    const { Readable } = await import('node:stream');
    await expect(driver.restore(a.appId, a.database, a.user, Readable.from([Buffer.from('not a dump')]))).rejects.toThrow(/restore failed/);
    expect(psqlFrom(net, a.url, 'SELECT body FROM notes')).toEqual({ ok: true, out: 'after' });

    await driver.restore(a.appId, a.database, a.user, Readable.from([dump]));
    expect(psqlFrom(net, a.url, 'SELECT body FROM notes')).toEqual({ ok: true, out: 'before' });
    // The restored tables belong to the app's role, which can keep writing.
    expect(psqlFrom(net, a.url, "INSERT INTO notes VALUES ('again'); SELECT count(*) FROM notes;")).toEqual({ ok: true, out: '2' });
  });

  it('remove deletes the server, its data and the network', async () => {
    const a = await makeDb();
    await driver.remove(a.appId);
    expect(await driver.status(a.appId)).toBe('missing');
    expect(spawnSync('docker', ['volume', 'inspect', `ys-db-${a.appId}`], { stdio: 'ignore' }).status).not.toBe(0);
    expect(spawnSync('docker', ['network', 'inspect', databaseNetwork(a.appId)], { stdio: 'ignore' }).status).not.toBe(0);
  });
});
