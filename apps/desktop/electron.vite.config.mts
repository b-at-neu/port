import { fileURLToPath, URL } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

// `--mode smoke` is the one build that honours `PORT_FIXTURES` even when packaged; every other mode compiles the flag to `false`.
export default defineConfig(({ mode }) => ({
  main: {
    resolve: { alias },
    define: { __PORT_PACKAGED_FIXTURES__: JSON.stringify(mode === 'smoke') },
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
