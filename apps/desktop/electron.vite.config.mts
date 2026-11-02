import { fileURLToPath, URL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fixtureBuild } from './scripts/fixture-modes.mjs'

const configDir = fileURLToPath(new URL('.', import.meta.url))
const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

/** The short commit baked into a dev build, or `null` when git is unavailable — a build must
 *  never fail over a cosmetic version suffix. */
function buildCommit(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: configDir, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: configDir, encoding: 'utf8' }).trim().length > 0
    return dirty ? `${sha}+dirty` : sha
  } catch {
    return null
  }
}

// Only `development`, `--mode fixtures` and `--mode smoke` bundle fixture data; `smoke` alone also honours `PORT_FIXTURES` when packaged. Every other mode, `production` included, resolves `#app-fixtures` to the stub.
export default defineConfig(({ mode }) => {
  const fixtures = fixtureBuild(mode)
  return {
    main: {
      resolve: {
        alias: {
          ...alias,
          '#app-fixtures': fileURLToPath(new URL(fixtures.compiled ? './tests/fixtures/app/index.ts' : './src/main/fixtures/absent.ts', import.meta.url))
        }
      },
      define: {
        __PORT_FIXTURES__: JSON.stringify(fixtures.compiled),
        __PORT_PACKAGED_FIXTURES__: JSON.stringify(fixtures.packaged),
        __PORT_BUILD_COMMIT__: JSON.stringify(buildCommit())
      },
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          input: {
            index: fileURLToPath(new URL('./src/main/index.ts', import.meta.url)),
            'state-worker': fileURLToPath(new URL('./src/main/offload/worker.ts', import.meta.url))
          }
        }
      }
    },
    preload: {
      resolve: { alias },
      plugins: [externalizeDepsPlugin()]
    },
    renderer: {
      resolve: { alias },
      plugins: [react(), tailwindcss()]
    }
  }
})
