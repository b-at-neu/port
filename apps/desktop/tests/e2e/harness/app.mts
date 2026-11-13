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
  app: ElectronApplication
  page: Page
  /** Closes and relaunches the app on the same user data and fake state, past the setup wizard. */
  relaunch(): Promise<void>
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
  /** Further `owner/name` repositories to register; the fake ignores owner/name, so each serves the same issues. */
  readonly extraRepos?: readonly string[]
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
  const extraPaths: string[] = []
  for (const [index, repo] of (params.extraRepos ?? []).entries()) {
    const extraDir = join(sandboxDir, `repo-${String(index + 2)}`)
    await mkdir(join(extraDir, '.claude'), { recursive: true })
    await writeFile(join(extraDir, '.claude', 'port.config.json'), JSON.stringify({ ...config, repo }, null, 2))
    extraPaths.push(extraDir)
  }
  await writeFile(join(userDataDir, 'registry.json'), JSON.stringify({ version: 1, repositories: [repoDir, ...extraPaths].map((path) => ({ path })) }, null, 2))
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

  const start = async (): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await _electron.launch({
      executablePath: electronBinary,
      args: ['--force-device-scale-factor=1', MAIN_ENTRY],
      env,
    })

    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }: typeof import('electron')) => {
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
    return { app, page }
  }

  const first = await start()
  const harness: E2EApp = {
    app: first.app,
    page: first.page,
    async relaunch() {
      await harness.app.close()
      const next = await start()
      harness.app = next.app
      harness.page = next.page
    },
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
      await harness.app.close()
      await rm(sandboxDir, { recursive: true, force: true })
    },
  }
  return harness
}

/** Every `node` call, or `claude` call beyond the setup wizard's own `--version` probe. */
export function assertNoDisallowedCalls(calls: readonly Call[]): void {
  const disallowed = calls.filter((call) => call.command === 'node' || (call.command === 'claude' && JSON.stringify(call.args) !== JSON.stringify(['--version'])))
  if (disallowed.length > 0) {
    throw new Error(`a claude/node call ran during the flow: ${JSON.stringify(disallowed)}`)
  }
}
