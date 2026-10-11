// The packaged-binary smoke harness's own Playwright config — a separate config from `playwright.config.mts` so `pnpm screenshots` never picks up `tests/smoke/packaged.spec.mts`, and vice versa.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/smoke',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  outputDir: 'out/playwright-packaged',
  reporter: 'list',
})
