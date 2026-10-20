import { defineConfig } from '@playwright/test';
import { generateRecipientKeyPair } from 'shared';

// One throwaway key pair per run: the page gets the public key, the test decrypts with the secret key.
// Workers inherit this environment, so the guard keeps the pair stable across config reloads.
if (!process.env.E2E_PUBLIC_KEY) {
  const { publicKey, secretKey } = await generateRecipientKeyPair();
  process.env.E2E_PUBLIC_KEY = Buffer.from(publicKey).toString('base64');
  process.env.E2E_SECRET_KEY = Buffer.from(secretKey).toString('base64');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5175',
    ...(process.env.CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } } : {}),
  },
  webServer: {
    command: 'node --import tsx e2e/server.ts',
    url: 'http://127.0.0.1:5175/healthz',
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PUBLIC_KEY: process.env.E2E_PUBLIC_KEY },
  },
});
