// On Linux, Electron's `chrome-sandbox` ships owner:owner 0755 after every `pnpm install`,
// since setting its setuid bit needs root — `pnpm install` never runs as root. Chromium's zygote
// needs that bit on AppArmor-hardened distros (Ubuntu 23.10+) even with `--no-sandbox`, so this
// fixes it once per resolved `electron` path via a single interactive `sudo` prompt. The check
// below is duplicated from `src/main/sandbox.ts` by design — scripts run untranspiled, so that
// file stays the tested definition; this is the thin, I/O-only mirror.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'linux') {
  process.exit(0)
}

const require = createRequire(import.meta.url)

let electronPackageJson
try {
  electronPackageJson = require.resolve('electron/package.json')
} catch {
  // `ensure-electron.mjs` owns binary presence; nothing to fix here if it's missing.
  process.exit(0)
}

const sandboxPath = join(dirname(electronPackageJson), 'dist', 'chrome-sandbox')

let stat
try {
  stat = statSync(sandboxPath)
} catch {
  process.exit(0)
}

const configured = stat.uid === 0 && (stat.mode & 0o7777) === 0o4755
if (configured) {
  process.exit(0)
}

const instruction = `[ensure-sandbox] chrome-sandbox needs root:root 4755 — run: sudo chown root:root ${sandboxPath} && sudo chmod 4755 ${sandboxPath}`

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error(instruction)
  process.exit(0)
}

console.log(`[ensure-sandbox] fixing chrome-sandbox permissions (one-time sudo prompt): ${sandboxPath}`)

const chown = spawnSync('sudo', ['chown', 'root:root', sandboxPath], { stdio: 'inherit' })
const chmod = chown.status === 0 ? spawnSync('sudo', ['chmod', '4755', sandboxPath], { stdio: 'inherit' }) : chown

if (chown.error || chmod.error || chown.status !== 0 || chmod.status !== 0) {
  console.error(instruction)
}

process.exit(0)
