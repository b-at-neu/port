// A stage session that ends on a network error is interrupted with the `network` reason, so its label stays and the sweeper retries it.
import { describe, expect, it, vi } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import type { ReadyEntry } from '@/types/actions'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { FileResult } from '@/types/platform'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../fixtures/app/repos'
import { memoryRuns } from '../../../support/state-store'
import { ticketOf } from '../../../support/tickets'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const WORKTREE = '/repo/.claude/worktrees/impl-52'

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
  const store = { start: vi.fn().mockResolvedValue({ ok: true, snapshot: errored(text) }), send: vi.fn().mockReturnValue({ ok: true }), close: vi.fn().mockResolvedValue({ ok: true }), dismiss: vi.fn(), list: vi.fn(() => []) }
  const { runs } = memoryRuns(WIDGETS_ID, { tickets: [ticketOf({ repo: WIDGETS_ID, ticket: 52, stage: 'implement' })] })
  const onOutcome = vi.fn()
  const launcher = createStageLauncher({
    store: store as never,
    git: vi.fn() as never,
    createWorktree: vi.fn().mockResolvedValue({ ok: true, path: WORKTREE, branch: '52-impl', baseSha: 'abc', baseLabel: '52-impl', reclaimed: null }),
    removeWorktree: vi.fn().mockResolvedValue({ outcome: 'removed' }),
    releaseBranch: vi.fn().mockResolvedValue('deleted'),
    sweepBranches: vi.fn().mockResolvedValue(undefined),
    now: () => new Date(),
    onOutcome,
    onResumedTurn: vi.fn(),
    pathExists: () => Promise.resolve(false),
    runs,
    newId: () => 'id-1',
    readStagePrompt: () => Promise.resolve(null),
    loadInstructions: vi.fn().mockResolvedValue({ ok: true, text: 'go', agent: { name: 'impl-agent', definition: { description: 'impl', prompt: 'body' }, selfContained: true } }),
    bundleRoot: '/bundle',
    ops: pathOps,
    readTextFile: () => Promise.resolve<FileResult<string>>({ ok: false, kind: 'not-found', message: 'unused' }),
  })
  await launcher.launch(request)
  launcher.observe(errored(text))
  await vi.waitFor(() => expect(onOutcome).toHaveBeenCalled())
  return { runs, store, onOutcome }
}

describe('createStageLauncher — a network failure', () => {
  it('closes the session and keeps the worktree, marking the run network so it is retried with backoff', async () => {
    const { runs, store, onOutcome } = await run("error_during_execution: API Error: Can't reach the API server (EAI_AGAIN)")
    expect(store.close).toHaveBeenCalledWith('hosted-1')
    expect(store.dismiss).not.toHaveBeenCalled()
    expect(runs.list()).toMatchObject([{ id: 'id-1', reason: 'network', detail: expect.stringContaining('EAI_AGAIN') as string }])
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'interrupted' }), null)
  })

  it('any other error stays an ordinary error run', async () => {
    const { runs } = await run('ran out of turns')
    expect(runs.list()).toMatchObject([{ id: 'id-1', reason: 'error' }])
  })
})
