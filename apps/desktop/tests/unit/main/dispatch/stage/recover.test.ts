import { describe, expect, it, vi } from 'vitest'
import { resumeStage, restartStage, RESUME_PROMPT } from '@/main/dispatch/stage/recover'
import type { AppContext } from '@/main/app/context'
import type { HostedSessionSnapshot, SessionKey } from '@/types/hosting'
import type { StageLaunchResult } from '@/types/dispatch'
import type { ReadyEntry } from '@/types/actions'
import type { ReleaseBranchOutcome, RemoveSessionWorktreeOutcome } from '@/types/workspace'
import type { StageResumeRequest } from '@/types/stage'
import type { Run } from '@/utils/pipeline/ticket'
import { WIDGETS_ID, FIXTURE_REPOSITORIES } from '../../../../fixtures/app/repos'
import { createTestContext } from '../../../../support/context'
import { runOf, ticketOf } from '../../../../support/tickets'

const hoisted = vi.hoisted(() => ({ remove: vi.fn(), release: vi.fn(), apply: vi.fn() }))
vi.mock('@/main/repos/worktree/worktree', async (original) => ({ ...(await original<object>()), removeSessionWorktreeAt: (_ctx: unknown, params: { path: string; force: boolean }) => hoisted.remove(params.path, params.force) as unknown }))
vi.mock('@/main/repos/worktree/stage-worktree', async (original) => ({ ...(await original<object>()), releaseStageBranch: (_ctx: unknown, params: { root: string; branch: string; baseSha: string }) => hoisted.release(params.root, params.branch, params.baseSha) as unknown }))
vi.mock('@/main/pipeline/operator/apply', async (original) => ({ ...(await original<object>()), applyItemAction: () => hoisted.apply() as unknown }))

const ENTRY = FIXTURE_REPOSITORIES.find((r) => r.id === WIDGETS_ID) as ReadyEntry

const interrupted = (overrides: Partial<Run> = {}): Run =>
  runOf({
    id: 's1',
    item: { kind: 'issue', number: 300 },
    claudeSessionId: 'claude-session-1',
    worktree: { path: '/tmp/wt', branch: 'b', baseSha: 'sha' },
    costUsd: 2.5,
    endedAt: '2026-01-01T00:05:00.000Z',
    interruption: { reason: 'crash', detail: null, at: '2026-01-01T00:05:00.000Z', resetsAt: null },
    ...overrides,
  })

async function setup(overrides: Partial<Run> = {}) {
  const list = vi.fn((): readonly HostedSessionSnapshot[] => [])
  const capacity = vi.fn(() => Promise.resolve({ limit: 4 }))
  const resume = vi.fn((request: StageResumeRequest): Promise<StageLaunchResult> => {
    void request
    return Promise.resolve({ ok: true, sessionKey: 'hosted-1' as SessionKey })
  })
  const live = {
    hostedStore: { list, capacity } as unknown as AppContext['live']['hostedStore'],
    stageLauncher: { resume } as unknown as AppContext['live']['stageLauncher'],
    watcher: { snapshot: () => ({}) } as unknown as AppContext['live']['watcher'],
  }
  const ctx = createTestContext({ tickets: { repoId: WIDGETS_ID, tickets: [ticketOf({ repo: WIDGETS_ID, ticket: 300, stage: 'implement', runs: [interrupted(overrides)] })] }, repositories: [ENTRY], live })
  await ctx.ready
  hoisted.remove.mockReset().mockResolvedValue({ outcome: 'removed' } satisfies RemoveSessionWorktreeOutcome)
  hoisted.release.mockReset().mockResolvedValue('deleted' satisfies ReleaseBranchOutcome)
  hoisted.apply.mockReset().mockResolvedValue({ ok: true, outcome: { kind: 'applied', argv: [] } })
  return { ctx, runs: ctx.stores.runs, list, capacity, resume }
}

describe('resumeStage', () => {
  it('hands the entry, its repository root and RESUME_PROMPT to the launcher', async () => {
    const deps = await setup()
    const result = await resumeStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'ok', sessionKey: 'hosted-1' })
    expect(deps.resume).toHaveBeenCalledTimes(1)
    const request = deps.resume.mock.calls[0]?.[0]
    expect(request?.entry).toMatchObject({ id: 's1', claudeSessionId: 'claude-session-1', worktree: { path: '/tmp/wt' } })
    expect(request?.root).toEqual({ path: ENTRY.path, sessionRequiredPaths: ENTRY.config.sessionRequiredPaths })
    expect(request?.prompt).toBe(RESUME_PROMPT.replace('<n>', '300'))
  })

  it('reports at-capacity when no slot is free', async () => {
    const deps = await setup()
    deps.capacity.mockResolvedValue({ limit: 1 })
    deps.list.mockReturnValue([{ phase: 'streaming' } as HostedSessionSnapshot])
    const result = await resumeStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'at-capacity', limit: 1 })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('maps the launcher refusing for capacity and for any other failure', async () => {
    const full = await setup()
    full.resume.mockResolvedValue({ ok: false, kind: 'at-capacity', limit: 2 })
    expect(await resumeStage(full.ctx, 's1')).toEqual({ kind: 'at-capacity', limit: 2 })

    const failed = await setup()
    failed.resume.mockResolvedValue({ ok: false, kind: 'failed', message: 'runtime problem', cause: 'resume' })
    expect(await resumeStage(failed.ctx, 's1')).toEqual({ kind: 'start-failed', message: 'runtime problem' })
  })

  it('reports start-failed when the repository is no longer configured', async () => {
    const deps = await setup()
    vi.spyOn(deps.ctx.repos, 'list').mockResolvedValue({ ok: true, repositories: [] })
    const result = await resumeStage(deps.ctx, 's1')
    expect(result).toMatchObject({ kind: 'start-failed' })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('reports no-session-id when the session died before init', async () => {
    const deps = await setup({ claudeSessionId: null })
    const result = await resumeStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'no-session-id' })
    expect(deps.resume).not.toHaveBeenCalled()
  })

  it('reports unknown-stage for an id with no interrupted run', async () => {
    const deps = await setup()
    const result = await resumeStage(deps.ctx, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})

describe('restartStage', () => {
  it('removes the worktree, applies retry, then clears the interruption and keeps the run as history', async () => {
    const deps = await setup()
    const result = await restartStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'ok' })
    expect(hoisted.remove).toHaveBeenCalledWith('/tmp/wt', false)
    expect(hoisted.release).toHaveBeenCalledWith(ENTRY.path, 'b', 'sha')
    expect(hoisted.apply).toHaveBeenCalled()
    expect(deps.runs.list()).toHaveLength(0)
    expect(deps.runs.runsOf(WIDGETS_ID, 'issue', 300)).toHaveLength(1)
  })

  it('releases no branch for a detached worktree', async () => {
    const deps = await setup({ worktree: { path: '/tmp/wt', branch: null, baseSha: 'sha' } })
    const result = await restartStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'ok' })
    expect(hoisted.release).not.toHaveBeenCalled()
  })

  it('stops at a dirty worktree and applies no label', async () => {
    const deps = await setup()
    hoisted.remove.mockResolvedValue({ outcome: 'dirty' })
    const result = await restartStage(deps.ctx, 's1')
    expect(result).toEqual({ kind: 'worktree-dirty' })
    expect(hoisted.release).not.toHaveBeenCalled()
    expect(hoisted.apply).not.toHaveBeenCalled()
    expect(deps.runs.list()).toHaveLength(1)
  })

  it('reports unknown-stage for an id with no interrupted run', async () => {
    const deps = await setup()
    const result = await restartStage(deps.ctx, 'nope')
    expect(result).toEqual({ kind: 'unknown-stage' })
  })
})
