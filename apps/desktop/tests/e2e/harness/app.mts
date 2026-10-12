// Launch/teardown helpers for the E2E harness, modeled on the visual harness's launchFixtureApp.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import type { ElectronApplication, Page } from 'playwright-core'
import { E2E_ENV } from '../../../src/main/e2e/mode'
import type { SandboxState } from '../fake/state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAIN_ENTRY = join(HERE, '..', '..', '..', 'out', 'main', 'index.js')
const FAKE_CLI = join(HERE, '..', 'fake', 'cli.mjs')

export interface Call {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
}

export interface E2EApp {
  readonly app: ElectronApplication
  readonly page: Page
  /** Every call the fake has recorded so far, oldest first. */
  calls(): Promise<readonly Call[]>
  /** The fake's mutable state file, re-read fresh every call — the next poll's own view. */
  state(): Promise<SandboxState>
  close(): Promise<void>
}

export interface LaunchParams {
  readonly state: SandboxState
  /** Extra `.claude/port.config.json` fields layered over the required `repo`. */
  readonly config?: Readonly<Record<string, unknown>>
}

/** Fails fast with the actual remedy, the same contract as the visual harness's own launcher. */
export async function launchE2EApp(params: LaunchParams): Promise<E2EApp> {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error('Built app not found. Run `pnpm e2e`, which builds first.')
  }

  const sandboxDir = await mkdtemp(join(tmpdir(), 'port-e2e-'))
  const repoDir = join(sandboxDir, 'repo')
  const userDataDir = join(sandboxDir, 'userData')
  const statePath = join(sandboxDir, 'fake-state.json')
  const callsPath = join(sandboxDir, 'calls.jsonl')

  await mkdir(join(repoDir, '.claude'), { recursive: true })
  await mkdir(userDataDir, { recursive: true })

  const config = { repo: params.state.repo, ...(params.config ?? {}) }
  await writeFile(join(repoDir, '.claude', 'port.config.json'), JSON.stringify(config, null, 2))
  await writeFile(join(userDataDir, 'registry.json'), JSON.stringify({ version: 1, repositories: [{ path: repoDir }] }, null, 2))
  await writeFile(statePath, JSON.stringify(params.state, null, 2))
  await writeFile(callsPath, '')

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env[E2E_ENV.flag] = '1'
  env[E2E_ENV.userData] = userDataDir
  env[E2E_ENV.fake] = FAKE_CLI
  env['PORT_E2E_STATE'] = statePath
  env['PORT_E2E_CALLS'] = callsPath
  delete env['PORT_FIXTURES']
  delete env['PORT_FIXTURES_USER_DATA']
  delete env['PORT_FIXTURES_SCENARIO']
  delete env['ELECTRON_RENDERER_URL']
  delete env['ELECTRON_RUN_AS_NODE']

  const electronBinary = createRequire(import.meta.url)('electron') as unknown as string

  const electronApp = await _electron.launch({
    executablePath: electronBinary,
    args: ['--force-device-scale-factor=1', MAIN_ENTRY],
    env,
  })

  const page = await electronApp.firstWindow()
  await electronApp.evaluate(({ BrowserWindow }: typeof import('electron')) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 800)
  })

  // The setup wizard's own Claude Code check always fails here (the fake refuses `claude
  // --version`); "Skip for now" is always present, so every flow starts past the wizard.
  const skip = page.getByRole('button', { name: 'Skip for now' })
  try {
    await skip.waitFor({ state: 'visible', timeout: 10_000 })
    await skip.click()
  } catch {
    // Already past the wizard — nothing to skip.
  }

  return {
    app: electronApp,
    page,
    async calls() {
      const raw = await readFile(callsPath, 'utf8')
      return raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Call)
    },
    async state() {
      return JSON.parse(await readFile(statePath, 'utf8')) as SandboxState
    },
    async close() {
      await electronApp.close()
      await rm(sandboxDir, { recursive: true, force: true })
    },
  }
}

/** Every `node` call, or `claude` call beyond the setup wizard's own `--version` probe. */
export function assertNoDisallowedCalls(calls: readonly Call[]): void {
  const disallowed = calls.filter((call) => call.command === 'node' || (call.command === 'claude' && JSON.stringify(call.args) !== JSON.stringify(['--version'])))
  if (disallowed.length > 0) {
    throw new Error(`a claude/node call ran during the flow: ${JSON.stringify(disallowed)}`)
  }
}
