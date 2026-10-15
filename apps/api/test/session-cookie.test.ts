import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { setSessionCookie } from '../src/http/middleware.js';

describe('session cookie', () => {
  it('is host-only: no Domain attribute (so *.BASE_DOMAIN sites never receive it)', async () => {
    const app = new Hono().get('/', (c) => { setSessionCookie(c, 'tok'); return c.text('ok'); });
    const sc = (await app.request('/')).headers.get('set-cookie')!;
    expect(sc).toContain('sid=tok');
    expect(sc.toLowerCase()).not.toContain('domain=');
    expect(sc).toContain('HttpOnly');
  });
});
