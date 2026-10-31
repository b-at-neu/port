// Fixes chrome-sandbox's setuid bit via one sudo prompt (AppArmor-hardened distros need it even
// with --no-sandbox). The permission check mirrors `src/main/sandbox.ts`, untranspiled here.
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
