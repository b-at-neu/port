// The visual harness's own Playwright config (#317) — one spec
// (`visual/screens.spec.ts`), serial, no retries: a flaky capture is a bug
// in the harness, not a timing issue to paper over.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'visual',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  forbidOnly: !!process.env['CI'],
  outputDir: 'out/playwright',
  reporter: 'list',
})
