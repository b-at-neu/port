import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  define: { __PORT_BUILD_COMMIT__: 'null', __PORT_RELEASE_REPO__: JSON.stringify('octo/port') },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts']
  }
})
