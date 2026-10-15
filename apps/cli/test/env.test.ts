import { describe, expect, it } from 'vitest';
import { envList, envSet, envUnset } from '../src/commands.js';

function fakeFetch(calls: { method: string; url: string; body?: string }[]): typeof fetch {
  return (async (u: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: u, body: init?.body as string | undefined });
    if (u.endsWith('/apps')) return new Response(JSON.stringify({ apps: [{ id: 'app1', name: 'site' }] }));
    if (init?.method === 'GET') return new Response(JSON.stringify({ vars: [{ name: 'A', updatedAt: 'x' }] }));
    return new Response(JSON.stringify({ ok: true }));
  }) as never;
}

describe('env commands', () => {
  it('list / set / unset hit the env routes with a JSON body for set', async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const b = { api: 'http://localhost:3001', token: 'ysk_x', app: 'site', fetch: fakeFetch(calls) };
    expect(await envList(b)).toEqual([{ name: 'A', updatedAt: 'x' }]);
    await envSet({ ...b, name: 'K', value: 'a=b' });
    await envUnset({ ...b, name: 'K' });
    expect(calls.filter((c) => !c.url.endsWith('/apps')).map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', 'http://localhost:3001/apps/app1/env', undefined],
      ['PUT', 'http://localhost:3001/apps/app1/env/K', '{"value":"a=b"}'],
      ['DELETE', 'http://localhost:3001/apps/app1/env/K', undefined],
    ]);
  });
});
