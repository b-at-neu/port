import { describe, expect, it, vi } from 'vitest'
import { createHostedHandle } from './handle'
import type { HostedQuery } from './handle'
import { DEFAULT_SESSION_DEFAULTS } from '../../shared/hosting/types'
import type { PluginRequest, SessionKey } from '../../shared/hosting/types'
import type { RepoId } from '../../shared/repos'

const SESSION_KEY = 'hosted-1' as SessionKey
const REPO_ID = 'repo-1' as RepoId
const INSTALLED_PLUGIN: PluginRequest = { source: 'installed' }

function fakeQuery() {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  const queue: unknown[] = []

  const setPermissionMode = vi.fn(() => Promise.resolve())
  const query: HostedQuery = {
    interrupt: () => Promise.resolve(undefined),
    close: () => undefined,
    supportedCommands: () => Promise.resolve([]),
    supportedAgents: () => Promise.resolve([]),
    setPermissionMode,
    setModel: () => Promise.resolve(),
    applyFlagSettings: () => Promise.resolve(),
    supportedModels: () => Promise.resolve([]),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
      }
    },
  } as unknown as HostedQuery

  return {
    query,
    setPermissionMode,
    push(message: unknown) {
      if (pendingResolve) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: false, value: message })
      } else {
        queue.push(message)
      }
    },
  }
}

function baseParams(overrides: Partial<Parameters<typeof createHostedHandle>[0]> = {}) {
  return {
    sessionKey: SESSION_KEY,
    repoId: REPO_ID,
    mode: { kind: 'fresh' as const },
    cwd: '/repo',
    executablePath: '/usr/local/bin/claude',
    credentials: null,
    now: () => 1_000,
    onEvent: vi.fn(),
    onStatus: vi.fn(),
    plugin: INSTALLED_PLUGIN,
    readExpectedComponents: () => Promise.resolve(null),
    samePath: (a: string, b: string) => a === b,
    initialTitle: null,
    defaults: DEFAULT_SESSION_DEFAULTS,
    ...overrides,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('setControls / answerQuestion / answerPlan', () => {
  it('setControls reports not-ready before init', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    const result = await handle.setControls({ permissionMode: 'acceptEdits' })
    expect(result).toEqual({ ok: false, kind: 'not-ready' })
  })

  it('setControls applies the patch once init has reported', async () => {
    const fake = fakeQuery()
    const handle = createHostedHandle(baseParams(), () => fake.query)
    fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' })
    await flush()
    const result = await handle.setControls({ permissionMode: 'acceptEdits' })
    expect(result).toEqual({ ok: true, controls: { permissionMode: 'acceptEdits', model: null, effort: null } })
    expect(fake.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
  })

  it('answerQuestion settles a pending AskUserQuestion call raised through options.canUseTool', async () => {
    const fake = fakeQuery()
    let capturedOptions: { canUseTool?: (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown> } | undefined
    const handle = createHostedHandle(baseParams(), (queryParams) => {
      capturedOptions = queryParams.options as typeof capturedOptions
      return fake.query
    })
    const controller = new AbortController()
    const resultPromise = capturedOptions?.canUseTool?.('AskUserQuestion', { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }] }, { signal: controller.signal, toolUseID: 'tool-use-1' })
    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string

    expect(handle.answerQuestion(permissionId, { 'Which?': 'A' })).toEqual({ ok: true })
    await expect(resultPromise).resolves.toEqual({ behavior: 'allow', updatedInput: { questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A' }] }], answers: { 'Which?': 'A' } }, toolUseID: 'tool-use-1' })
  })

  it('a plan approved through answerPlan updates controls.permissionMode without a second SDK call', () => {
    const fake = fakeQuery()
    let capturedOptions: { canUseTool?: (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<unknown> } | undefined
    const handle = createHostedHandle(baseParams(), (queryParams) => {
      capturedOptions = queryParams.options as typeof capturedOptions
      return fake.query
    })
    const controller = new AbortController()
    void capturedOptions?.canUseTool?.('ExitPlanMode', { plan: 'Steps' }, { signal: controller.signal, toolUseID: 'tool-use-1' })
    const permissionId = handle.snapshot().pendingPermissions[0]?.permissionId as string

    expect(handle.answerPlan(permissionId, { kind: 'approve', mode: 'acceptEdits' })).toEqual({ ok: true })
    expect(handle.snapshot().controls.permissionMode).toBe('acceptEdits')
    expect(fake.setPermissionMode).not.toHaveBeenCalled()
  })
})
