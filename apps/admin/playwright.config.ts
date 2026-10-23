import { defineConfig } from '../upload/playwright-api.js';
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 90_000, expect: { timeout: 15_000 }, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5185', extraHTTPHeaders: { 'tailscale-user-login': 'owner@tailnet' },
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
  },
  webServer: { command: 'node --import tsx e2e/server.ts', cwd: import.meta.dirname, url: 'http://127.0.0.1:5185/', reuseExistingServer: false, timeout: 60_000 },
});
