// The E2E harness's own config — serial, no retries, CI-only.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.mts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  outputDir: 'out/playwright-e2e',
  reporter: 'list',
})
