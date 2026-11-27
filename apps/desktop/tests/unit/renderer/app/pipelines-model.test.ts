import { describe, expect, it } from 'vitest'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import type { AttachedAgent, PipelineState, ReconciledItem, RepositoryState } from '@/types/state'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { SOURCE_BASE_INTERVAL_MS, STALE_GRACE_MS } from '@/types/board'
import type { PipelineRow, ReadyPipelineRow } from '@/types/shell'
import type { TickClaim, TickReport } from '@/types/tick'
import { displayRunState, phaseLineOf, pipelinesModel as pipelinesModelOf } from '@/renderer/app/pipelines-model'
import { needsYouItems } from '@/renderer/board/needs-you'
import type { Stage, Status } from '@/utils/pipeline/ticket'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import { reconciledItem } from '../../../support/board-snapshot'
import { stageSession } from '../../../support/session-snapshot'
import { queuedAt, ticketAt } from '../../../support/tickets'

function assertReady(row: PipelineRow | undefined): ReadyPipelineRow {
  if (row === undefined || !row.ready) throw new Error('expected a ready row')
  return row
}

const NOW = new Date('2026-01-01T01:00:00.000Z')
const REPO_ID = 'repo-a' as RepoId

/** `useNeedsYouItems` with nothing dismissed: the visible list is derived from the snapshot, then handed to the model. */
function sidebarModel(repos: readonly RepositoryEntry[], snapshot: BoardSnapshot | undefined, now: Date = NOW, sessions: readonly HostedSessionSnapshot[] = []) {
  return pipelinesModelOf(repos, snapshot, snapshot !== undefined ? needsYouItems(snapshot, now) : [], sessions)
}

function pipelinesModel(repos: readonly RepositoryEntry[], snapshot: BoardSnapshot | undefined, now: Date = NOW, sessions: readonly HostedSessionSnapshot[] = []) {
  return sidebarModel(repos, snapshot, now, sessions).repos
}

function agent(overrides: Partial<AttachedAgent> = {}): AttachedAgent {
  return { agentId: 'a1', agentType: 'impl-agent', stage: 'impl-agent', model: 'sonnet', activity: 'active', idleMs: 0, lastActivityAt: NOW.toISOString(), match: 'direct', sessionId: 'sess-1', ...overrides }
}

const RUNNING: Status = { kind: 'running', runId: null }
const WAITING_ON_PLAN: Status = { kind: 'waiting-on-you', gate: 'plan-approval', detail: '' }

/** An implementing issue by default; `at` swaps the ticket's stage and status, keeping its number. */
function item(overrides: Partial<ReconciledItem> = {}, at: { readonly stage: Stage; readonly status: Status } = { stage: 'implement', status: RUNNING }): ReconciledItem {
  const number = overrides.number ?? 42
  return reconciledItem({
    repoId: REPO_ID,
    repo: 'o/a',
    kind: 'issue',
    number,
    title: 'a ticket',
    url: `https://github.com/o/a/issues/${String(number)}`,
    status: 'in-flight',
    statusEvidence: 'agent-active',
    waitingOn: null,
    ticket: ticketAt(at.stage, at.status, { ticket: number }),
    ...overrides,
  })
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
    integrationChecks: {},
    approvalGate: true,
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
      displayVocabulary: resolveDisplayVocabulary({}),
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
    expect(rows).toEqual([{ ready: false, repoId: 'repo-b', name: 'o/b', sessions: [], userSessions: [] }])
  })

  it('lists a live stage session under a not-ready repository, never an ended one or another repository\'s', () => {
    const stage = { agent: 'plan', number: 44, kind: 'issue' } as const
    const sessions = [
      stageSession({ key: 'live', repoId: 'repo-b' as RepoId, stage }),
      stageSession({ key: 'ended', repoId: 'repo-b' as RepoId, phase: 'ended', stage: { ...stage, number: 45 } }),
      stageSession({ key: 'other', repoId: REPO_ID, stage: { ...stage, number: 46 } }),
    ]
    const [row] = pipelinesModel([notReadyEntry()], undefined, NOW, sessions)
    expect(row).toMatchObject({ ready: false, sessions: [{ key: 'live', number: 44, label: '#44', sessionKey: 'live', tone: { palette: 'plan', fill: 'active', pulse: true }, statusText: 'Planning' }] })
  })

  it('reads a ready repository as stopped with no snapshot yet', () => {
    const row = assertReady(pipelinesModel([readyEntry()], undefined)[0])
    expect(row).toMatchObject({ ready: true, pill: { status: 'idle', label: 'Stopped' }, inFlight: 0, needsYouCount: 0, sessions: [], userSessions: [] })
  })

  it('lists a live session row, never a dormant one', () => {
    const live = item({ agents: [agent({ activity: 'active' })] })
    const dormant = item({ number: 43, agents: [agent({ activity: 'dormant' })] })
    const snapshot = snapshotOf([readyRepoState({ items: [live, dormant] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions).toEqual([
      { key: `${REPO_ID}-42`, repoId: REPO_ID, number: 42, label: '#42 a ticket', tone: { palette: 'implement', fill: 'active', pulse: true }, statusText: 'Implementing', phaseName: 'Implementing', sessionKey: null, transcript: { sessionId: 'sess-1', agentId: 'a1' } },
    ])
  })

  it('lists no row for an item whose agent is only idle', () => {
    const queued = item({ agents: [agent({ activity: 'idle' })] }, { stage: 'implement', status: queuedAt('new') })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [queued] })]))[0])
    expect(row.sessions).toEqual([])
  })

  it('lists no row for a terminal item, even with an active agent', () => {
    const approved = item({ agents: [agent()] }, { stage: 'merge', status: { kind: 'done', at: NOW.toISOString() } })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [approved] })]))[0])
    expect(row.sessions).toEqual([])
  })

  it('lists no row for a gate item that needs the operator, but still lights the repo dot', () => {
    const waiting = item({ waitingOn: 'cockpit', agents: [agent()] }, { stage: 'plan', status: WAITING_ON_PLAN })
    const snapshot = snapshotOf([readyRepoState({ items: [waiting] })])
    const row = assertReady(pipelinesModel([readyEntry()], snapshot)[0])
    expect(row.sessions).toEqual([])
    expect(row.needsYouCount).toBe(1)
  })

  it('lights no dot for an item the visible list leaves out', () => {
    const waiting = item({ waitingOn: 'cockpit', agents: [agent()] }, { stage: 'plan', status: WAITING_ON_PLAN })
    const snapshot = snapshotOf([readyRepoState({ items: [waiting] })])
    expect(assertReady(pipelinesModelOf([readyEntry()], snapshot, []).repos[0]).needsYouCount).toBe(0)
  })

  describe('user sessions', () => {
    function userSession(key: string, repoId: RepoId | null, overrides: Partial<HostedSessionSnapshot> = {}): HostedSessionSnapshot {
      const base = stageSession({ key, repoId: REPO_ID, stage: { agent: 'plan', number: 1, kind: 'issue' } })
      return { ...base, repoId, stage: null, ...overrides }
    }

    it("gives each repository only its own open user sessions and leaves stage sessions out", () => {
      const stage = { agent: 'plan', number: 44, kind: 'issue' } as const
      const sessions = [
        userSession('mine', REPO_ID),
        userSession('theirs', 'repo-b' as RepoId),
        userSession('ended', REPO_ID, { phase: 'ended' }),
        stageSession({ key: 'stage', repoId: REPO_ID, stage }),
      ]
      const model = sidebarModel([readyEntry(), notReadyEntry()], undefined, NOW, sessions)
      expect(model.repos.map((row) => row.userSessions.map((s) => s.sessionKey))).toEqual([['mine'], ['theirs']])
      expect(model.otherSessions).toEqual([])
    })

    it('puts a session with no repository, or an unregistered one, in otherSessions', () => {
      const sessions = [userSession('none', null), userSession('unknown', 'repo-z' as RepoId), userSession('mine', REPO_ID)]
      const model = sidebarModel([readyEntry()], undefined, NOW, sessions)
      expect(model.otherSessions.map((s) => s.sessionKey)).toEqual(['none', 'unknown'])
      expect(assertReady(model.repos[0]).userSessions.map((s) => s.sessionKey)).toEqual(['mine'])
    })

    it('counts the same items its filtered screen lists', () => {
      const waiting = item({ waitingOn: 'cockpit' }, { stage: 'plan', status: WAITING_ON_PLAN })
      const snapshot = snapshotOf([readyRepoState({ items: [waiting, item({ number: 43, waitingOn: 'cockpit' }, { stage: 'plan', status: WAITING_ON_PLAN })] })])
      const items = needsYouItems(snapshot, NOW)
      expect(assertReady(pipelinesModelOf([readyEntry()], snapshot, items).repos[0]).needsYouCount).toBe(items.filter((i) => i.repoId === REPO_ID).length)
      expect(items).toHaveLength(2)
    })
  })

  it('drops a stage session while it waits on a permission prompt, and lists it again once answered', () => {
    const stage = { agent: 'impl', number: 42, kind: 'issue' } as const
    const waiting = { ...stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage }), pendingPermissions: [pendingPermission()] }
    const answered = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage })
    const snapshot = snapshotOf([readyRepoState({ items: [item({ agents: [agent()] })] })])
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [waiting])[0]).sessions).toEqual([])
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [answered])[0]).sessions[0]).toMatchObject({ tone: { palette: 'implement', fill: 'active', pulse: true }, statusText: 'Implementing' })
  })

  it('drops an idle hosted stage session without resurrecting the item row for its number', () => {
    const stage = { agent: 'impl', number: 42, kind: 'issue' } as const
    const idle = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage, phase: 'ready' })
    const snapshot = snapshotOf([readyRepoState({ items: [item({ agents: [agent()] })] })])
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [idle])[0]).sessions).toEqual([])
  })

  it('reads the phase line as the phase, with Needs you appended while waiting on the operator', () => {
    const running = { palette: 'implement', fill: 'active', pulse: true } as const
    const waiting = { palette: 'needs-you', fill: 'active', pulse: true } as const
    expect(phaseLineOf({ tone: waiting, phaseName: 'Implementing' })).toBe('Implementing · Needs you')
    expect(phaseLineOf({ tone: running, phaseName: 'Implementing' })).toBe('Implementing')
  })

  it.each([
    ['questions', 'Done thinking.\n\nQUESTIONS FOR HUMAN:\n1. Which layout?'],
    ['blocked', 'BLOCKED: gh pr create — denied'],
  ])('drops a stage session on a %s hand-back', (_kind, text) => {
    const stage = { agent: 'impl', number: 42, kind: 'issue' } as const
    const session = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage, lastResult: { subtype: 'success', isError: false, text, at: NOW.toISOString() } })
    const row = assertReady(pipelinesModel([readyEntry()], snapshotOf([readyRepoState({ items: [item()] })]), NOW, [session])[0])
    expect(row.sessions).toEqual([])
  })

  it('keeps the phase colour on an ordinary completed hand-back', () => {
    const stage = { agent: 'impl', number: 42, kind: 'issue' } as const
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
      capabilities: { kind: 'pending' },
      title: null,
      rateLimit: null,
      controls: { permissionMode: 'default', model: null, effort: null },
      models: { kind: 'pending' },
      usage: null,
      stage: { agent: 'impl', number: 42, kind: 'issue' },
      lastResult: null,
      backgroundTasks: [],
      operatorJoinedAt: null,
    }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [stageSnapshot])[0])
    expect(row.sessions).toHaveLength(1)
    expect(row.sessions[0]).toMatchObject({ number: 42, sessionKey: 'hosted-1' })
  })

  it('labels a stage row with the session title, falling back to the ticket label, never the phase', () => {
    const queued = item({ agents: [agent({ activity: 'active' })] }, { stage: 'implement', status: queuedAt('new') })
    const snapshot = snapshotOf([readyRepoState({ items: [queued] })])
    const stage = { agent: 'impl', number: 42, kind: 'issue' } as const
    const untitled = stageSession({ key: 'hosted-impl', repoId: REPO_ID, stage })
    const titled = { ...untitled, title: '#42 a titled ticket' }
    expect(assertReady(pipelinesModel([readyEntry()], snapshot)[0]).sessions[0]?.label).toBe('#42 a ticket')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [titled])[0]).sessions[0]?.label).toBe('#42 a titled ticket')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [untitled])[0]).sessions[0]?.label).toBe('#42 a ticket')
  })

  it("resolves a revise session on a pull request to its ticket's number and keeps the ticket as one row", () => {
    const linked = [item({ number: 46, title: 'the ticket', linked: 47, agents: [agent({ activity: 'active' })] }), item({ number: 47, kind: 'pull-request', title: 'the pull request', linked: 46 })]
    const snapshot = snapshotOf([readyRepoState({ items: linked })])
    const revise = { ...stageSession({ key: 'hosted-revise', repoId: REPO_ID, stage: { agent: 'revise', number: 47, kind: 'pull-request' } }), title: '#46 the ticket' }
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [revise])[0])
    expect(row.sessions).toEqual([{ key: 'hosted-revise', repoId: REPO_ID, number: 46, label: '#46 the ticket', tone: { palette: 'revise', fill: 'active', pulse: true }, statusText: 'Revising', phaseName: 'Revising', sessionKey: 'hosted-revise', transcript: null }])
  })

  it('keeps a review session on a pull request as one row for its ticket', () => {
    const linked = [
      item({ number: 637, title: 'the ticket', linked: 670 }),
      item({ number: 670, kind: 'pull-request', title: 'the pull request', linked: 637, agents: [agent({ activity: 'active' })] }, { stage: 'review', status: RUNNING }),
    ]
    const snapshot = snapshotOf([readyRepoState({ items: linked })])
    const review = stageSession({ key: 'hosted-review', repoId: REPO_ID, stage: { agent: 'review', number: 670, kind: 'pull-request' } })
    expect(assertReady(pipelinesModel([readyEntry()], snapshot)[0]).sessions).toHaveLength(1)
    const row = assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [review])[0])
    expect(row.sessions).toHaveLength(1)
    expect(row.sessions[0]).toMatchObject({ number: 637, sessionKey: 'hosted-review' })
  })

  it('drops an idle review session on a pull request without resurrecting its ticket row', () => {
    const linked = [
      item({ number: 637, title: 'the ticket', linked: 670 }),
      item({ number: 670, kind: 'pull-request', title: 'the pull request', linked: 637, agents: [agent({ activity: 'active' })] }, { stage: 'review', status: RUNNING }),
    ]
    const snapshot = snapshotOf([readyRepoState({ items: linked })])
    const idle = stageSession({ key: 'hosted-review', repoId: REPO_ID, phase: 'ready', stage: { agent: 'review', number: 670, kind: 'pull-request' } })
    expect(assertReady(pipelinesModel([readyEntry()], snapshot, NOW, [idle])[0]).sessions).toEqual([])
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

describe('displayRunState', () => {
  const STAGE = { agent: 'impl', number: 42, kind: 'issue' } as const
  const CLAIM: TickClaim = { number: 42, kind: 'issue', stage: 'implement', class: 'matched', retryable: false }

  function tickOf(overrides: Partial<TickReport> = {}): TickReport {
    return { repoId: REPO_ID, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], autoApprovals: [],nextTickAt: null, observations: [], labelRepairs: [], ...overrides }
  }

  function snapshotWith(state: 'dispatching' | 'draining' | 'paused', tick: readonly TickReport[]): BoardSnapshot {
    return { ...snapshotOf([readyRepoState()]), tick, runStates: { store: { kind: 'loaded' as const }, repositories: [{ repoId: REPO_ID, state, since: null }] } }
  }

  it('reads a draining repository with nothing in flight as stopped, with the pill to match', () => {
    const snapshot = snapshotWith('draining', [tickOf()])
    expect(displayRunState(snapshot, REPO_ID, [])).toBe('stopped')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot)[0]).pill).toEqual({ status: 'idle', label: 'Stopped' })
  })

  it('keeps a draining repository draining while a claim is in flight', () => {
    const snapshot = snapshotWith('draining', [tickOf({ claims: [CLAIM] })])
    expect(displayRunState(snapshot, REPO_ID, [])).toBe('draining')
    expect(assertReady(pipelinesModel([readyEntry()], snapshot)[0]).pill).toEqual({ status: 'attention', label: 'Draining' })
  })

  it('keeps a draining repository draining while a stage session is live, even one waiting on a permission prompt', () => {
    const snapshot = snapshotWith('draining', [tickOf()])
    const live = stageSession({ key: 'live', repoId: REPO_ID, stage: STAGE })
    const waiting = { ...live, pendingPermissions: [pendingPermission()] }
    expect(displayRunState(snapshot, REPO_ID, [live])).toBe('draining')
    expect(displayRunState(snapshot, REPO_ID, [waiting])).toBe('draining')
  })

  it("ignores another repository's live session and this repository's ended one", () => {
    const snapshot = snapshotWith('draining', [tickOf()])
    const other = stageSession({ key: 'other', repoId: 'repo-b' as RepoId, stage: STAGE })
    const ended = stageSession({ key: 'ended', repoId: REPO_ID, stage: STAGE, phase: 'ended' })
    expect(displayRunState(snapshot, REPO_ID, [other, ended])).toBe('stopped')
  })

  it('never reads a blind or missing tick as a finished drain', () => {
    expect(displayRunState(snapshotWith('draining', [tickOf({ blind: { reason: 'viewer-unknown' } })]), REPO_ID, [])).toBe('draining')
    expect(displayRunState(snapshotWith('draining', []), REPO_ID, [])).toBe('draining')
  })

  it('passes a dispatching or paused repository through, and reads no snapshot as stopped', () => {
    expect(displayRunState(snapshotWith('dispatching', [tickOf()]), REPO_ID, [])).toBe('dispatching')
    expect(displayRunState(snapshotWith('paused', [tickOf({ claims: [CLAIM] })]), REPO_ID, [])).toBe('stopped')
    expect(displayRunState(undefined, REPO_ID, [])).toBe('stopped')
  })
})
