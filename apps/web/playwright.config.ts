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
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' },
  },
  webServer: [
    {
      // Fresh API per run so the in-memory rate limiters start empty.
      command: 'pnpm --filter api db:migrate && pnpm --filter api start',
      url: 'http://localhost:3001/healthz',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter web dev',
      url: 'http://localhost:5173/ja/login',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { API_ORIGIN: 'http://localhost:3001' },
    },
  ],
});
