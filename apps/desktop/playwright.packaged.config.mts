// The packaged-binary harness's own Playwright config — a separate config from `playwright.config.mts` so `pnpm screenshots` never picks up these specs, and vice versa. Runs both the launch smoke test (release binary) and the visual capture (smoke copy): `app.mts` reads `PORT_VISUAL_PACKAGED` at module top, which Playwright re-evaluates per worker.
import { defineConfig } from '@playwright/test'

process.env['PORT_VISUAL_PACKAGED'] = '1'

export default defineConfig({
  testDir: 'tests',
  testMatch: ['smoke/**/*.spec.mts', 'visual/**/*.spec.mts'],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  outputDir: 'out/playwright-packaged',
  reporter: 'list',
})
