import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '#app-route': fileURLToPath(new URL('./src/main/platform/route.ts', import.meta.url))
    }
  },
  define: { __PORT_BUILD_COMMIT__: 'null', __PORT_RELEASE_REPO__: JSON.stringify('octo/port'), __PORT_E2E__: 'false' },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/scenarios/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      reporter: ['text-summary']
    }
  }
})
