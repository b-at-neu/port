import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardSnapshot } from '@/types/board'
import type { RepoDispatchStatus } from '@/types/dispatch'
import type { PendingPermission, SessionKey } from '@/types/hosting'
import type { InterruptedStage, StageDenial } from '@/types/stage'
import type { RepositoryState } from '@/types/state'
import { needsYouItems } from '@/renderer/board/needs-you'
import { boardSnapshot, repositoryState } from '../../../fixtures/board-state'
import { stageSession } from '../../../fixtures/stage-session'

const NOW = new Date('2026-01-01T01:00:00.000Z')
const REPO_A = 'repo-a' as RepoId
const REPO_B = 'repo-b' as RepoId

function dispatchStatus(overrides: Partial<RepoDispatchStatus> = {}): RepoDispatchStatus {
  return { repoId: REPO_A, owner: 'app', state: { kind: 'idle' }, runState: 'dispatching', ownedSince: null, unreadableMessage: null, budget: null, observed: [], denials: [], interrupted: [], ...overrides }
}

function snapshotOf(dispatch: readonly RepoDispatchStatus[], repositories: readonly RepositoryState[] = []): BoardSnapshot {
  return { ...boardSnapshot(repositories), dispatch }
}

describe('stage-denial rows', () => {
  const SESSION = 'hosted-300' as SessionKey
  const denial: StageDenial = { id: 'd1', repoId: REPO_A, agent: 'impl', number: 300, toolName: 'Bash', inputSummary: 'pnpm exec playwright test', rule: 'Bash(pnpm *)', at: '2026-01-01T00:30:00.000Z', sessionKey: SESSION }
  const stage = { agent: 'impl' as const, number: 300, kind: 'issue' as const, trigger: 'planApproved' as const }
  const snapshot = snapshotOf([dispatchStatus({ denials: [denial] })])
  const idleAfter = (at: string, phase: 'ready' | 'streaming' | 'ended' = 'ready') => stageSession({ key: SESSION, repoId: REPO_A, stage, phase, lastResult: { subtype: 'success', isError: false, text: 'stopped', at } })

  const liveOf = (sessions: Parameters<typeof needsYouItems>[2], from: BoardSnapshot = snapshot) => needsYouItems(from, NOW, sessions).map((item) => (item.kind === 'stage-denial' ? item.live : null))

  it('is live while its own session is idle after the denial', () => {
    const items = needsYouItems(snapshot, NOW, [idleAfter('2026-01-01T00:40:00.000Z')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-denial', number: 300, live: true })
  })

  it('is live when the session went idle at the very instant of the denial', () => {
    expect(liveOf([idleAfter(denial.at)])).toEqual([true])
  })

  it('still shows, not live, once its session has ended', () => {
    expect(liveOf([idleAfter('2026-01-01T00:40:00.000Z', 'ended')])).toEqual([false])
  })

  it('still shows, not live, while the session is still working', () => {
    expect(liveOf([idleAfter('2026-01-01T00:40:00.000Z', 'streaming')])).toEqual([false])
  })

  it('still shows, not live, when the session last went idle before the denial', () => {
    expect(liveOf([idleAfter('2026-01-01T00:10:00.000Z')])).toEqual([false])
  })

  it('still shows, not live, when no session carries its key or the denial has none (a relaunch)', () => {
    expect(liveOf([])).toEqual([false])
    const unkeyed = snapshotOf([dispatchStatus({ denials: [{ ...denial, sessionKey: null }] })])
    expect(liveOf([idleAfter('2026-01-01T00:40:00.000Z')], unkeyed)).toEqual([false])
  })
})

describe('stage-approval items', () => {
  const stage = { agent: 'impl' as const, number: 300, kind: 'issue' as const, trigger: 'planApproved' as const }
  const permission = (permissionId: string, overrides: Partial<PendingPermission> = {}): PendingPermission => ({
    permissionId,
    toolName: 'Edit',
    input: {},
    title: null,
    displayName: null,
    description: null,
    decisionReason: null,
    blockedPath: null,
    protectedPath: '.claude/settings.json',
    agentId: null,
    requestedAt: '2026-01-01T00:30:00.000Z',
    sessionGrant: null,
    interaction: null,
    ...overrides,
  })
  const sessionWith = (pendingPermissions: PendingPermission[], phase: 'streaming' | 'ended' = 'streaming') => stageSession({ key: 'hosted-300', repoId: REPO_A, stage, phase, pendingPermissions })

  it('derives one item for a pending protected edit', () => {
    const items = needsYouItems(snapshotOf([]), NOW, [sessionWith([permission('p1')])])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-approval', number: 300, sessionKey: 'hosted-300', permissionId: 'p1', agent: 'impl', toolName: 'Edit', path: '.claude/settings.json', at: '2026-01-01T00:30:00.000Z' })
  })

  it('derives one row per pending protected edit', () => {
    const items = needsYouItems(snapshotOf([]), NOW, [sessionWith([permission('p1'), permission('p2', { requestedAt: '2026-01-01T00:40:00.000Z', protectedPath: 'CLAUDE.md' })])])
    expect(items.map((i) => (i.kind === 'stage-approval' ? i.permissionId : null))).toEqual(['p2', 'p1'])
  })

  it('yields nothing for an ended session', () => {
    expect(needsYouItems(snapshotOf([]), NOW, [sessionWith([permission('p1')], 'ended')])).toEqual([])
  })

  it('yields nothing for a permission with no protected path', () => {
    expect(needsYouItems(snapshotOf([]), NOW, [sessionWith([permission('p1', { protectedPath: null })])])).toEqual([])
  })

  it('keeps a question as a stage-question, never a stage-approval', () => {
    const question = permission('p1', { toolName: 'AskUserQuestion', protectedPath: null, interaction: { kind: 'question' as const, questions: [{ question: 'Which?', header: 'Branch', multiSelect: false, options: [] }] } })
    const items = needsYouItems(snapshotOf([]), NOW, [sessionWith([question])])
    expect(items.map((i) => i.kind)).toEqual(['stage-question'])
  })
})

describe('interrupted entries', () => {
  function interrupted(overrides: Partial<InterruptedStage> = {}): InterruptedStage {
    return {
      id: 'i1',
      repoId: REPO_A,
      agent: 'plan',
      number: 301,
      kind: 'issue',
      trigger: 'ready',
      inFlight: 'planning',
      model: 'opus',
      claudeSessionId: null,
      worktree: { path: '/wt', branch: 'b', baseSha: 's' },
      startedAt: '2026-01-01T00:00:00.000Z',
      interruptedAt: '2026-01-01T00:20:00.000Z',
      reason: 'crash',
      detail: null,
      resetsAt: null,
      costUsd: null,
      ...overrides,
    }
  }

  it('derives a stage-interrupted item timed by when it was interrupted', () => {
    const items = needsYouItems(snapshotOf([dispatchStatus({ interrupted: [interrupted()] })]), NOW)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'stage-interrupted', number: 301, at: '2026-01-01T00:20:00.000Z' })
  })

  it('collapses every usage-limit entry across repositories into one item', () => {
    const dispatch = [
      dispatchStatus({
        interrupted: [
          interrupted({ id: 'a', number: 38, reason: 'usage-limit', resetsAt: '2026-01-01T14:05:00.000Z' }),
          interrupted({ id: 'b', number: 39, reason: 'usage-limit', resetsAt: '2026-01-01T14:00:00.000Z', interruptedAt: '2026-01-01T00:40:00.000Z' }),
        ],
      }),
      dispatchStatus({ repoId: REPO_B, interrupted: [interrupted({ id: 'c', repoId: REPO_B, number: 12, reason: 'usage-limit', resetsAt: null })] }),
    ]
    const repos = [repositoryState([]), repositoryState([], { repoId: REPO_B, repo: 'o/b', displayName: 'o/b' })]
    const items = needsYouItems(snapshotOf(dispatch, repos), NOW)
    expect(items).toHaveLength(1)
    const [only] = items
    expect(only).toMatchObject({ kind: 'usage-limit', repoId: null, number: null, resetsAt: '2026-01-01T14:05:00.000Z', at: '2026-01-01T00:40:00.000Z' })
    expect(only?.kind === 'usage-limit' ? only.entries.map((e) => e.id) : []).toEqual(['a', 'b', 'c'])
    expect(only?.kind === 'usage-limit' ? only.repoNames.get(REPO_B) : null).toBe('o/b')
  })

  it('reads a usage-limit item with no known reset as resetsAt: null', () => {
    const dispatch = [dispatchStatus({ interrupted: [interrupted({ reason: 'usage-limit', resetsAt: null })] })]
    expect(needsYouItems(snapshotOf(dispatch), NOW)[0]).toMatchObject({ kind: 'usage-limit', resetsAt: null })
  })

  it('keeps other reasons as their own rows beside the usage-limit line', () => {
    const dispatch = [dispatchStatus({ interrupted: [interrupted({ id: 'a', reason: 'usage-limit', resetsAt: '2026-01-01T14:05:00.000Z' }), interrupted({ id: 'b', number: 302, reason: 'quit' })] })]
    const kinds = needsYouItems(snapshotOf(dispatch), NOW).map((i) => i.kind)
    expect(kinds.sort()).toEqual(['stage-interrupted', 'usage-limit'])
  })

  it('emits no usage-limit item when no entry hit the limit', () => {
    const dispatch = [dispatchStatus({ interrupted: [interrupted({ reason: 'error' })] })]
    expect(needsYouItems(snapshotOf(dispatch), NOW).map((i) => i.kind)).toEqual(['stage-interrupted'])
  })
})
