// The visual harness's own xvfb-aware runner (#317) — `pnpm screenshots`
// builds first (package.json's own script), then this spawns Playwright
// directly or wrapped in `xvfb-run` on Linux, with no shell in either case
// (argv passed as an array, never a concatenated string). `cwd` is always
// `apps/desktop`, resolved from this file's own location rather than
// whatever directory the caller happened to invoke `pnpm` from.
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const forwardedArgs = process.argv.slice(2)

const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')

function commandExists(command) {
  // `spawnSync` sets `.error` (an `ENOENT`-shaped error) only when the
  // executable itself could not be found — the command's own exit code,
  // whatever it is, still means it ran.
  const result = spawnSync(command, ['--help'], { stdio: 'ignore' })
  return result.error === undefined
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: appRoot, stdio: 'inherit', shell: false })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (error) => {
      console.error(`[screenshots] failed to run ${command}:`, error)
      resolve(1)
    })
  })
}

async function main() {
  const isLinux = process.platform === 'linux'
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

  let code
  if (isLinux && commandExists('xvfb-run')) {
    code = await run('xvfb-run', ['-a', '--server-args=-screen 0 1920x1080x24', process.execPath, playwrightCli, 'test', ...forwardedArgs])
  } else if (isLinux && !hasDisplay) {
    console.error('No display and no xvfb-run. Install xvfb (`sudo apt install xvfb`) or run with a display.')
    process.exit(1)
  } else {
    if (isLinux) console.log('xvfb-run not found; windows will open on your display.')
    code = await run(process.execPath, [playwrightCli, 'test', ...forwardedArgs])
  }

  if (code !== 0) {
    process.exit(code)
  }

  const outDir = join(appRoot, 'out', 'screenshots')
  console.log(`Screenshots: ${outDir}`)
  if (existsSync(outDir)) {
    for (const file of readdirSync(outDir).sort()) {
      console.log(file)
    }
  }
}

await main()
