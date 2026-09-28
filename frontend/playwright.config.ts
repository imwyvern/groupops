import { defineConfig } from '@playwright/test';

// Runs against a live stack: `pnpm db:up && pnpm migrate`, both mocks, backend, and `pnpm dev`.
// CHROME=/path/to/chrome reuses an already-installed browser instead of `npx playwright install`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    launchOptions: process.env.CHROME ? { executablePath: process.env.CHROME } : {},
    trace: 'retain-on-failure',
  },
});
