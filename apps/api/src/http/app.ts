import { Hono } from 'hono';
import type { Db } from '../db/client.js';
import type { Mailer } from '../mail/mailer.js';
import { requestRecovery, type RecoveryRequestConfig } from '../auth/recovery.js';
import { rateLimit } from './middleware.js';

export interface AppDeps {
  db: Db;
  mailer: Mailer;
  config: RecoveryRequestConfig;
}

const clientIp = (c: { req: { header(n: string): string | undefined } }): string =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

export function createApp(deps?: AppDeps): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  if (deps) {
    app.post('/auth/recovery/request', rateLimit(clientIp, 10, 3600), async (c) => {
      const body = await c.req.json().catch(() => null) as { email?: unknown; recoveryCode?: unknown } | null;
      if (typeof body?.email !== 'string' || typeof body.recoveryCode !== 'string' || body.email.length > 320 || body.recoveryCode.length > 200) {
        return c.json({ error: 'invalid' }, 400);
      }
      const r = await requestRecovery(deps.db, deps.mailer, { email: body.email, recoveryCode: body.recoveryCode }, deps.config);
      if ('error' in r) return c.json({ error: r.error }, r.error === 'rate_limited' ? 429 : 400);
      // The request ID is intentionally not returned: the user only learns that the request was received.
      return c.json({ ok: true });
    });
  }
  return app;
}
