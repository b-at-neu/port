import { describe, expect, it, vi } from 'vitest'
import { pathOps } from '@/main/platform/paths'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import type { AppContext } from '@/main/app/context'
import type { ReadyEntry } from '@/types/actions'
import type { StageLaunchRequest } from '@/types/dispatch'
import type { HostedSessionSnapshot, SessionKey, StartSessionParams } from '@/types/hosting'
import type { FileResult } from '@/types/platform'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../fixtures/app/repos'
import { createTestContext } from '../../../support/context'
import { ticketOf } from '../../../support/tickets'

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry
const WORKTREE = '/repo/.claude/worktrees/plan-52'
const PLAN_PATH = pathOps.join(WORKTREE, '.temp', 'plan-52.md')

const wt = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('@/main/repos/worktree/stage-worktree', async (original) => ({
  ...(await original<object>()),
  createStageWorktree: (_ctx: unknown, params: unknown) => wt.create(params) as unknown,
  releaseStageBranch: () => Promise.resolve('deleted'),
  sweepSessionBranches: () => Promise.resolve({ done: true, deleted: [] }),
}))
vi.mock('@/main/repos/worktree/worktree', async (original) => ({ ...(await original<object>()), removeSessionWorktreeAt: () => Promise.resolve({ outcome: 'removed' }) }))
vi.mock('@/main/dispatch/stage/instructions', async (original) => ({
  ...(await original<object>()),
  loadStageLaunch: () => Promise.resolve({ ok: true, text: 'prompt', agent: { name: 'plan-agent', definition: { description: 'plan', prompt: 'body' }, selfContained: true } }),
}))
vi.mock('@/main/sessions/hosting/stage-prompt-store', async (original) => ({ ...(await original<object>()), readStagePrompt: () => Promise.resolve(null) }))

function request(agent: StageLaunchRequest['agent']): StageLaunchRequest {
  return { entry: ENTRY, agent, number: 52, kind: 'issue', trigger: 'ready', model: 'opus', prompt: 'Run your pipeline stage for #52.', title: '#52 Plan', target: { kind: 'issue', title: 'Plan' }, review: null }
}

function snapshot(text: string): HostedSessionSnapshot {
  return {
    sessionKey: 'hosted-1' as SessionKey,
    claudeSessionId: 'sdk-1',
    repoId: WIDGETS_ID,
    workspace: { folder: WORKTREE, root: '/repo', worktree: { path: WORKTREE, branch: '52-plan' }, base: { sha: 'abc', label: '52-plan' } },
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
    stage: { agent: 'plan', number: 52, kind: 'issue', trigger: 'ready' },
    lastResult: { subtype: 'success', isError: false, text, at: 't1' },
    backgroundTasks: [],
    operatorJoinedAt: null,
  }
}

async function settle(read: FileResult<string>, text: string, agent: StageLaunchRequest['agent'] = 'plan') {
  wt.create.mockReset().mockResolvedValue({ ok: true, path: WORKTREE, branch: '52-plan', baseSha: 'abc', baseLabel: '52-plan', reclaimed: null })
  const start = vi.fn<(params: StartSessionParams) => Promise<unknown>>().mockResolvedValue({ ok: true, snapshot: snapshot(text) })
  const dismiss = vi.fn().mockResolvedValue({ ok: true })
  const store = { start, send: vi.fn().mockReturnValue({ ok: true }), close: vi.fn().mockResolvedValue({ ok: true }), dismiss, list: vi.fn(() => []) }
  const onOutcome = vi.fn()
  const live = { hostedStore: store as unknown as AppContext['live']['hostedStore'], dispatcher: { recordOutcome: onOutcome, recordResumedTurn: vi.fn() } as unknown as AppContext['live']['dispatcher'] }
  const ctx = createTestContext({ tickets: { repoId: WIDGETS_ID, tickets: [ticketOf({ repo: WIDGETS_ID, ticket: 52, stage: 'plan' })] }, live })
  await ctx.ready
  const readTextFile = vi.spyOn(ctx.fs, 'readText').mockImplementation((path: string) => Promise.resolve<FileResult<string>>(path === PLAN_PATH ? read : { ok: false, kind: 'not-found', message: `ENOENT ${path}` }))
  const launcher = createStageLauncher(ctx, '/bundle')
  await launcher.launch(request(agent))
  launcher.observe(snapshot(text))
  await vi.waitFor(() => expect(onOutcome).toHaveBeenCalled())
  return { onOutcome, readTextFile, dismiss }
}

const PLAN_WRITTEN = 'Plan done.\nHANDBACK: plan-written'
const readsPlan = (readTextFile: { readonly mock: { readonly calls: readonly (readonly [string])[] } }) => readTextFile.mock.calls.some(([path]) => path === PLAN_PATH)

describe('createStageLauncher — the plan file', () => {
  it('reads the plan body verbatim on a completed plan-written hand-back', async () => {
    const { onOutcome } = await settle({ ok: true, value: '\n## Implementation Plan\n' }, PLAN_WRITTEN)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.objectContaining({ kind: 'completed' }), { kind: 'read', body: '\n## Implementation Plan\n' })
  })

  it('reads it before the worktree is dismissed', async () => {
    const { readTextFile, dismiss } = await settle({ ok: true, value: 'plan' }, PLAN_WRITTEN)
    const index = readTextFile.mock.calls.findIndex(([path]) => path === PLAN_PATH)
    expect(readTextFile.mock.invocationCallOrder[index]).toBeLessThan(dismiss.mock.invocationCallOrder[0] ?? 0)
  })

  it('reports a blank file as empty', async () => {
    const { onOutcome } = await settle({ ok: true, value: ' \n\t\n' }, PLAN_WRITTEN)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.anything(), { kind: 'empty' })
  })

  it('reports an absent file as missing with no detail', async () => {
    const { onOutcome } = await settle({ ok: false, kind: 'not-found', message: 'ENOENT' }, PLAN_WRITTEN)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.anything(), { kind: 'missing', detail: null })
  })

  it('reports any other read failure as missing with its message', async () => {
    const { onOutcome } = await settle({ ok: false, kind: 'permission-denied', message: 'EACCES: denied' }, PLAN_WRITTEN)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.anything(), { kind: 'missing', detail: 'EACCES: denied' })
  })

  it('reads nothing for another stage, even with the same token text', async () => {
    const { onOutcome, readTextFile } = await settle({ ok: true, value: 'plan' }, PLAN_WRITTEN, 'impl')
    expect(readsPlan(readTextFile)).toBe(false)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.anything(), null)
  })

  it('reads nothing for a plan session that handed back another token', async () => {
    const { onOutcome, readTextFile } = await settle({ ok: true, value: 'plan' }, 'HANDBACK: something-else')
    expect(readsPlan(readTextFile)).toBe(false)
    expect(onOutcome).toHaveBeenCalledWith(WIDGETS_ID, 'hosted-1', expect.anything(), null)
  })
})
