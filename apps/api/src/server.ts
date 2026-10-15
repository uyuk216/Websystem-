import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createApp } from './http/app.js';

const config = loadConfig(process.env);
serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(`api listening on :${info.port}`);
});
