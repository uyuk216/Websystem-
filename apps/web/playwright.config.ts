import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      // Fresh API per run so the in-memory rate limiters start empty.
      command: 'pnpm --filter api db:migrate && pnpm --filter api start',
      url: 'http://localhost:3001/healthz',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Small upload limit so the 413 UI is testable; dummy GitHub App so PATCH /apps/:id/github exists
        // (GitHub itself is never called: an unlinked installation is rejected with 403 first).
        UPLOAD_MAX_BYTES: '100000',
        // Every test signs up from 127.0.0.1; the per-IP mail limit (20 per 10 minutes) would cut the suite off.
        AUTH_START_LIMIT: '500',
        GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'dummy', GITHUB_WEBHOOK_SECRET: 'e2e-secret',
        GITHUB_CLIENT_ID: 'e2e', GITHUB_CLIENT_SECRET: 'e2e',
      },
    },
    {
      command: 'pnpm --filter web dev',
      url: 'http://localhost:5173/ja/login',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_ORIGIN: 'http://localhost:3001' },
    },
    {
      // Deployment processing (worker) and the static site server (:8090) run together.
      command: 'pnpm -r --parallel --filter worker --filter static dev',
      port: 8090,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
