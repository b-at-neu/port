import { describe, expect, it } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { AttachedAgent, PipelineState, ReconciledItem, RepositoryState } from '@/types/state'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '@/types/board'
import type { PipelineRow, ReadyPipelineRow } from '@/types/shell'
import { pipelinesModel as pipelinesModelOf } from '@/renderer/shell/pipelines-model'
import { needsYouItems } from '@/renderer/board/needs-you'
import { stageSession } from '../../../fixtures/stage-session'

function assertReady(row: PipelineRow | undefined): ReadyPipelineRow {
  if (row === undefined || !row.ready) throw new Error('expected a ready row')
  return row
}

const NOW = new Date('2026-01-01T01:00:00.000Z')
const REPO_ID = 'repo-a' as RepoId

/** `useNeedsYouItems` with nothing dismissed: the visible list is derived from the snapshot, then handed to the model. */
function pipelinesModel(repos: readonly RepositoryEntry[], snapshot: BoardSnapshot | undefined, now: Date = NOW, sessions: readonly HostedSessionSnapshot[] = []) {
  return pipelinesModelOf(repos, snapshot, snapshot !== undefined ? needsYouItems(snapshot, now) : [], sessions)
}

function agent(overrides: Partial<AttachedAgent> = {}): AttachedAgent {
  return { agentId: 'a1', agentType: 'impl-agent', stage: 'impl-agent', model: 'sonnet', activity: 'active', idleMs: 0, lastActivityAt: NOW.toISOString(), match: 'direct', sessionId: 'sess-1', ...overrides }
}

function item(overrides: Partial<ReconciledItem> = {}): ReconciledItem {
  return {
    repoId: REPO_ID,
    repo: 'o/a',
    kind: 'issue',
    number: 42,
    title: 'a ticket',
    url: 'https://github.com/o/a/issues/42',
    assignees: ['op'],
    stage: 'in-flight',
    stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }],
    stageAmbiguous: false,
    marked: true,
    autoPlan: false,
    status: 'in-flight',
    statusEvidence: 'agent-active',
    waitingOn: null,
    sessionRequired: false,
    linked: null,
    linkReason: null,
    agents: [],
    sessions: [],
    worktrees: [],
    workSessions: [],
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    stageHistory: [],
    matchedKeys: ['inProgress'],
    sources: ['github'],
    claimedFiles: null,
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    reviewCycleCount: null,
    checkRollup: null,
    planPresent: null,
    ...overrides,
  }
}

function pendingPermission(): HostedSessionSnapshot['pendingPermissions'][number] {
  return {
    permissionId: 'p1',
    toolName: 'Bash',
    input: {},
    title: null,
    displayName: null,
    description: null,
    decisionReason: null,
    blockedPath: null,
    protectedPath: null,
    agentId: null,
    requestedAt: NOW.toISOString(),
    sessionGrant: null,
    interaction: null,
  }
}

function readyRepoState(overrides: Partial<Extract<RepositoryState, { ok: true }>> = {}): Extract<RepositoryState, { ok: true }> {
  return {
    ok: true,
    repoId: REPO_ID,
    repo: 'o/a',
    displayName: 'o/a',
    items: [],
    orphans: [],
    uncorrelatedWorktrees: [],
    denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW.toISOString() },
    diagnostics: [],
    vocabulary: { verdict: 'verified', present: [], missing: [], problems: [], repoLabels: { ok: true, names: [] } },
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-01-01T02:00:00Z', limit: 5000 },
    freshness: {
      github: { at: NOW.toISOString() },
      itemStates: { unavailable: 'no re-check needed' },
      sessions: { at: NOW.toISOString() },
      worktrees: { at: NOW.toISOString() },
      denials: { at: NOW.toISOString() },
    },
    worktreeTotals: { registered: 0, attached: 0, uncorrelated: 0 },
    viewer: 'op',
    approvalGate: true,
    disabled: [],
    concurrency: { sharedFiles: [], overlapThreshold: 2 },
    reviewCycleCap: 5,
    ...overrides,
  }
}

function snapshotOf(repositories: readonly RepositoryState[]): BoardSnapshot {
  const state: PipelineState = { repositories, sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW.toISOString() }, readAt: NOW.toISOString() }
  return {
    state,
    health: [],
    policy: { baseIntervalMs: SOURCE_BASE_INTERVAL_MS, backoffCeilingMs: 900_000, rateLimitFloor: 200, staleGraceMs: STALE_GRACE_MS },
    tick: [],
    runStates: { store: { kind: 'loaded' }, repositories: [] },
    nextWakeupAt: null,
    emittedAt: NOW.toISOString(),
    dispatch: [],
    autoPlan: [],
  }
}

function notReadyEntry(): RepositoryEntry {
  return { id: 'repo-b' as RepoId, path: '/repo-b', displayName: 'o/b', problem: { kind: 'directory-missing' }, diagnostics: [] }
}

function readyEntry(): RepositoryEntry {
  return {
    id: REPO_ID,
    path: '/repo-a',
    displayName: 'o/a',
    status: 'ready',
    diagnostics: [],
    config: {
      repo: 'o/a',
      owner: 'o',
      name: 'a',
      branches: { integration: 'dev', production: 'main' },
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: { labels: [], disabled: [], problems: [] },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
    },
  }
}

describe('pipelinesModel', () => {
  it('renders a bare not-ready row with no sessions', () => {
    const rows = pipelinesModel([notReadyEntry()], undefined)
    expect(rows).toEqual([{ ready: false, repoId: 'repo-b', name: 'o/b', sessions: [] }])
  })

  it('lists a live stage session under a not-ready repository, never an ended one or another repository\'s', () => {
    const stage = { agent: 'plan', number: 44, kind: 'issue', trigger: 'ready' } as const
    const sessions = [
      stageSession({ key: 'live', repoId: 'repo-b' as RepoId, stage }),
      stageSession({ key: 'ended', repoId: 'repo-b' as RepoId, phase: 'ended', stage: { ...stage, number: 45 } }),
      stageSession({ key: 'other', repoId: REPO_ID, stage: { ...stage, number: 46 } }),
    ]
    const [row] = pipelinesModel([notReadyEntry()], undefined, NOW, sessions)
    expect(row).toMatchObject({ ready: false, sessions: [{ key: 'live', number: 44, label: '#44', sessionKey: 'live', tone: { palette: 'plan', fill: 'active', pulse: false }, statusText: 'Planning' }] })
  })

  it('reads a ready repository as paused with no snapshot yet', () => {
    const row = assertReady(pipelinesModel([readyEntry()], undefined)[0])
    expect(row).toMatchObject({ ready: true, pill: { status: 'idle', label: 'Paused' }, inFlight: 0, needsYou: false, sessions: [] })
  })

  it('lists a live session row, never a dormant one', () => {
    const live = item({ agents: [agent({ activity: 'active' })] })
    const dormant = item({ number: 43, agents: [agent({ activity: 'dormant' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [live, dormant] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions).toEqual([
      { key: `${REPO_ID}-42`, repoId: REPO_ID, number: 42, label: '#42 a ticket', tone: { palette: 'implement', fill: 'active', pulse: false }, statusText: 'Implementing', sessionKey: null, transcript: { sessionId: 'sess-1', agentId: 'a1' } },
    ])
  })

  it('an idle detected session on a queued trigger shows a ring in its phase colour', () => {
    const queued = item({ stage: 'trigger', stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], agents: [agent({ activity: 'idle' })] })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [queued] })]))[0])
    expect(row.sessions[0]).toMatchObject({ tone: { palette: 'implement', fill: 'queued', pulse: false }, statusText: 'Plan approved' })
  })

  it('pulses a session in its phase colour when its item needs the operator', () => {
    const waiting = item({ stage: 'gate', stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], waitingOn: 'cockpit', agents: [agent()] })
    const snapshot = snapshotOf([readyRepoState({ items: [waiting] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions[0]).toMatchObject({ tone: { palette: 'plan', fill: 'active', pulse: true }, statusText: 'Plan review' })
    expect(row.needsYou).toBe(true)
  })

  it('lights no dot for an item the visible list leaves out', () => {
    const waiting = item({ stage: 'gate', stages: [{ key: 'planReview', name: 'plan review', role: 'gate' }], waitingOn: 'cockpit', agents: [agent()] })
    const snapshot = snapshotOf([readyRepoState({ items: [waiting] })])
    expect(assertReady(pipelinesModelOf([readyEntry()], snapshot, [])[0]).needsYou).toBe(false)
  })

  it('shows a needs-you gate in red with the Needs you status text', () => {
    const blocked = item({ stage: 'gate', stages: [{ key: 'blocked', name: 'blocked', role: 'gate' }], waitingOn: 'cockpit', agents: [agent()] })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [blocked] })]))[0])
    expect(row.sessions[0]).toMatchObject({ tone: { palette: 'needs-you', fill: 'active', pulse: true }, statusText: 'Needs you' })
  })

  it('turns a stage session red while it waits on a permission prompt, and back once it is answered', () => {
    const stage = { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' } as const
    const waiting = { ...stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage }), pendingPermissions: [pendingPermission()] }
    const answered = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage })
    const snapshot = snapshotOf([readyRepoState({ items: [item()] })])
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [waiting])[0]).sessions[0]).toMatchObject({ tone: { palette: 'needs-you', fill: 'active', pulse: true }, statusText: 'Needs you' })
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [answered])[0]).sessions[0]).toMatchObject({ tone: { palette: 'implement', fill: 'active', pulse: false }, statusText: 'Implementing' })
  })

  it.each([
    ['questions', 'Done thinking.\n\nQUESTIONS FOR HUMAN:\n1. Which layout?'],
    ['blocked', 'BLOCKED: gh pr create — denied'],
  ])('turns a stage session red on a %s hand-back', (_kind, text) => {
    const stage = { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' } as const
    const session = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage, lastResult: { subtype: 'success', isError: false, text, at: NOW.toISOString() } })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [item()] })]), NOW, [session])[0])
    expect(row.sessions[0]).toMatchObject({ tone: { palette: 'needs-you', pulse: true }, statusText: 'Needs you' })
  })

  it('keeps the phase colour on an ordinary completed hand-back', () => {
    const stage = { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' } as const
    const session = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage, lastResult: { subtype: 'success', isError: false, text: 'Opened PR #9.', at: NOW.toISOString() } })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [item()] })]), NOW, [session])[0])
    expect(row.sessions[0]?.tone.palette).toBe('implement')
  })

  it('a stage session row replaces an item-derived row for the same number', () => {
    const live = item({ agents: [agent({ activity: 'active' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [live] })])
    const stageSnapshot: HostedSessionSnapshot = {
      sessionKey: 'hosted-1' as HostedSessionSnapshot['sessionKey'],
      claudeSessionId: 's1',
      repoId: REPO_ID,
      workspace: { folder: '/repo', root: '/repo', worktree: null, base: null },
      phase: 'streaming',
      origin: { kind: 'fresh' },
      startedAt: NOW.toISOString(),
      queuedAfterInterrupt: null,
      end: null,
      titled: null,
      pendingPermissions: [],
      capabilities: { kind: 'pending', request: { source: 'installed' } },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default', model: null, effort: null },
      models: { kind: 'pending' },
      usage: null,
      stage: { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' },
      lastResult: null,
      backgroundTasks: [],
      operatorJoinedAt: null,
    }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [stageSnapshot])[0])
    expect(row.sessions).toHaveLength(1)
    expect(row.sessions[0]).toMatchObject({ number: 42, sessionKey: 'hosted-1' })
  })

  it('labels a stage row with the session title, falling back to the ticket label, never the phase', () => {
    const queued = item({ stage: 'trigger', stages: [{ key: 'planApproved', name: 'plan approved', role: 'trigger' }], agents: [agent({ activity: 'active' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [queued] })])
    const stage = { agent: 'impl', number: 42, kind: 'issue', trigger: 'planApproved' } as const
    const untitled = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage })
    const titled = { ...untitled, title: '#42 a titled ticket' }
    expect(assertReady(pipelinesModel([readyEntry()], snapshot)[0]).sessions[0]?.label).toBe('#42 a ticket')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [titled])[0]).sessions[0]?.label).toBe('#42 a titled ticket')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [untitled])[0]).sessions[0]?.label).toBe('#42 a ticket')
  })

  it("resolves a revise session on a pull request to its ticket's number and keeps the ticket as one row", () => {
    const linked = [item({ number: 46, title: 'the ticket', linked: 47, agents: [agent({ activity: 'active' })] }), item({ number: 47, kind: 'pull-request', title: 'the pull request', linked: 46 })]
    const snapshot = snapshotOf([readyRepoState({ items: linked })])
    const revise = { ...stageSession({ key: 'hosted-revise', repoId: REPO_ID, stage: { agent: 'revise', number: 47, kind: 'pull-request', trigger: 'needsRevision' } }), title: '#46 the ticket' }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [revise])[0])
    expect(row.sessions).toEqual([{ key: 'hosted-revise', repoId: REPO_ID, number: 46, label: '#46 the ticket', tone: { palette: 'revise', fill: 'active', pulse: false }, statusText: 'Revising', sessionKey: 'hosted-revise', transcript: null }])
  })

  it('shows a ticket with a linked pull request as one item row, never a second for the pull request', () => {
    const linked = [item({ number: 46, title: 'the ticket', linked: 47 }), item({ number: 47, kind: 'pull-request', title: 'the pull request', linked: 46, agents: [agent({ activity: 'active' })] })]
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: linked })]))[0])
    expect(row.sessions.map((s) => [s.number, s.label])).toEqual([[46, '#46 the ticket']])
  })

  it('transcript target prefers the live agent, falling back to the live session', () => {
    const agentOnly = item({ agents: [agent()] })
    const sessionOnly = item({
      number: 43,
      agents: [],
      sessions: [{ sessionId: 'sess-2', role: 'implement', roleEvidence: 'worktree-name', activity: 'active', idleMs: 0, lastActivityAt: NOW.toISOString(), match: 'direct' }],
    })
    const snapshot = snapshotOf([readyRepoState({ items: [agentOnly, sessionOnly] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions.find((s) => s.number === 42)?.transcript).toEqual({ sessionId: 'sess-1', agentId: 'a1' })
    expect(row.sessions.find((s) => s.number === 43)?.transcript).toEqual({ sessionId: 'sess-2', agentId: null })
  })

  it('reads the persisted run state into the pill', () => {
    const snapshot = { ...snapshotOf([readyRepoState()]), runStates: { store: { kind: 'loaded' as const }, repositories: [{ repoId: REPO_ID, state: 'draining' as const, since: null }] } }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.pill).toEqual({ status: 'attention', label: 'Draining' })
  })
})
