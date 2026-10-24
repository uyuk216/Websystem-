import { isLimitSettingKey, validLimitValue, validateSecuritySetting } from 'shared';
import type { Hono, MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import type { AdminDeps } from './server.js';
import { withAdmin } from './audit-log.js';
import { jsonBody } from './validation.js';
import { platformSettings } from '../db/schema.js';
export function registerSettings(app: Hono, deps: AdminDeps, ownerOnly: MiddlewareHandler): void {
  const { db } = deps;
  app.get('/admin/settings', async (c) => {
    const rows = await withAdmin(db, c.get('operator'), { action: 'settings.list', target: '*' }, (tx) => tx.select().from(platformSettings));
    return c.json({ settings: rows });
  });
  app.put('/admin/settings/:key', ownerOnly, async (c) => {
    const key = c.req.param('key');
    const b = await jsonBody(c);
    if (!/^[a-z0-9_.-]{1,100}$/i.test(key) || !b || !('value' in b)) return c.json({ error: 'invalid' }, 400);
    // Plan limits (`limits.*`) must be known keys with a non-negative number, otherwise they would silently do nothing.
    if (key.startsWith('limits.') && (!isLimitSettingKey(key) || !validLimitValue(b.value))) return c.json({ error: 'invalid' }, 400);
    // `security.*` は既知キーだけ。範囲外・無制限・本番での test モードは拒否する。
    if (key.startsWith('security.') && !validateSecuritySetting(key, b.value, { production: deps.production ?? process.env.NODE_ENV === 'production' }).ok) return c.json({ error: 'invalid' }, 400);
    const op = c.get('operator');
    // Before/after values are part of the record.
    await withAdmin(db, op, { action: 'settings.update', target: key }, async (tx, ctx) => {
      const [before] = await tx.select().from(platformSettings).where(sql`${platformSettings.key} = ${key}`);
      await tx.insert(platformSettings).values({ key, value: b.value as never, updatedBy: op.accountId })
        .onConflictDoUpdate({ target: platformSettings.key, set: { value: b.value as never, updatedBy: op.accountId, updatedAt: new Date() } });
      await ctx.audit('settings.changed', key, { before: before?.value ?? null, after: b.value as never });
    });
    return c.json({ ok: true });
  });

}
