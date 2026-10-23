import type { Context } from 'hono';
export const validId = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const b: unknown = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b as Record<string, unknown> : null;
}
export function respond(c: Context, r: unknown): Response {
  if (r && typeof r === 'object' && 'error' in r) return c.json(r, r.error === 'not_found' ? 404 : 400);
  return c.json(r as object);
}
