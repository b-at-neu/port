import { fileURLToPath, URL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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

// `--mode smoke` is the one build that honours `PORT_FIXTURES` even when packaged; every other mode compiles the flag to `false`.
export default defineConfig(({ mode }) => ({
  main: {
    resolve: { alias },
    define: { __PORT_PACKAGED_FIXTURES__: JSON.stringify(mode === 'smoke'), __PORT_BUILD_COMMIT__: JSON.stringify(buildCommit()) },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss()]
  }
}))
