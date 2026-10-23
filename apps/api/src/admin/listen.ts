import { serve } from '@hono/node-server';
import { createAdminApp, type AdminDeps } from './server.js';
export function listenAdmin(deps: AdminDeps, port: number, hostname: string) {
  return serve({ fetch: createAdminApp(deps).fetch, port, hostname });
}

export { getRequestListener } from '@hono/node-server';
