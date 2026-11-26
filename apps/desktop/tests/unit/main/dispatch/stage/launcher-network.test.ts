// A stage session that ends on a network error is interrupted with the `network` reason, so its label stays and the sweeper retries it.
import { describe, expect, it, vi } from 'vitest'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import type { AppContext } from '@/main/app/context'
import type { ReadyEntry } from '@/types/actions'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../../fixtures/app/repos'
import { createTestContext } from '../../../../support/context'
import { ticketOf } from '../../../../support/tickets'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const WORKTREE = '/repo/.claude/worktrees/impl-52'

const wt = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/main/repos/worktree/stage-worktree', async (original) => ({
  ...(await original<object>()),
  createStageWorktree: (_ctx: unknown, params: unknown) => wt.create(params) as unknown,
  releaseStageBranch: () => Promise.resolve('deleted'),
  sweepSessionBranches: () => Promise.resolve({ done: true, deleted: [] }),
}))
vi.mock('@/main/dispatch/stage/instructions', async (original) => ({
  ...(await original<object>()),
  loadStageLaunch: () => Promise.resolve({ ok: true, text: 'go', agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' }, selfContained: true } }),
}))
vi.mock('@/main/sessions/hosting/stage-prompt-store', async (original) => ({ ...(await original<object>()), readStagePrompt: () => Promise.resolve(null) }))

const request: StageLaunchRequest = { entry: ENTRY, agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved', model: 'sonnet', prompt: 'Run.', title: '#52 Impl', target: { kind: 'issue', title: 'Impl' }, review: null }

function errored(text: string): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: WIDGETS_ID,
    workspace: { folder: WORKTREE, root: '/repo', worktree: { path: WORKTREE, branch: '52-impl' }, base: { sha: 'abc', label: '52-impl' } },
    phase: 'streaming',
    origin: { kind: 'fresh' },
    startedAt: '2026-01-01T00:00:00Z',
    queuedAfterInterrupt: null,
    end: null,
    titled: null,
    pendingPermissions: [],
    capabilities: { kind: 'pending' },
    title: null,
    rateLimit: null,
    controls: { permissionMode: 'default', model: null, effort: null },
    models: { kind: 'pending' },
    usage: null,
    stage: { agent: 'impl', number: 52, kind: 'issue', trigger: 'planApproved' },
    lastResult: { subtype: 'error_during_execution', isError: true, text, at: 't1' },
    backgroundTasks: [],
    operatorJoinedAt: null,
  }
}

async function run(text: string) {
  wt.create.mockReset().mockResolvedValue({ ok: true, path: WORKTREE, branch: '52-impl', baseSha: 'abc', baseLabel: '52-impl', reclaimed: null })
  const store = { start: vi.fn().mockResolvedValue({ ok: true, snapshot: errored(text) }), send: vi.fn().mockReturnValue({ ok: true }), close: vi.fn().mockResolvedValue({ ok: true }), dismiss: vi.fn(), list: vi.fn(() => []) }
  const onOutcome = vi.fn()
  const live = { hostedStore: store as unknown as AppContext['live']['hostedStore'], dispatcher: { recordOutcome: onOutcome, recordResumedTurn: vi.fn() } as unknown as AppContext['live']['dispatcher'] }
  const ctx = createTestContext({ tickets: { repoId: WIDGETS_ID, tickets: [ticketOf({ repo: WIDGETS_ID, ticket: 52, stage: 'implement' })] }, live })
  await ctx.ready
  const launcher = createStageLauncher(ctx, '/bundle')
  await launcher.launch(request)
  launcher.observe(errored(text))
  await vi.waitFor(() => expect(onOutcome).toHaveBeenCalled())
  return { runs: ctx.stores.runs, store, onOutcome }
}

describe('createStageLauncher — a network failure', () => {
  it('closes the session and keeps the worktree, marking the run network so it is retried with backoff', async () => {
    const { runs, store, onOutcome } = await run("error_during_execution: API Error: Can't reach the API server (EAI_AGAIN)")
    expect(store.close).toHaveBeenCalledWith('hosted-1')
    expect(store.dismiss).not.toHaveBeenCalled()
    expect(runs.list()).toMatchObject([{ reason: 'network', detail: expect.stringContaining('EAI_AGAIN') as string }])
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'interrupted' }), null)
  })

  it('any other error stays an ordinary error run', async () => {
    const { runs } = await run('ran out of turns')
    expect(runs.list()).toMatchObject([{ reason: 'error' }])
  })
})
