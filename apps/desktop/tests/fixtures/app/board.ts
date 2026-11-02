// Canned reads pass through the real, pure `reconcileRepository` and `planTick`, so a screenshot shows exactly what the real derivation produces. Every timestamp is `now` plus a fixed offset, so "5m ago" renders the same on every run.
import { labelName } from '@/utils/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import { LABEL_DEFAULTS } from '@/utils/labels/defaults'
import type { LabelEventNode, PipelineFetch, PipelineItem, QueriedLabel } from '@/types/github'
import type { AgentRecord, SessionRecord } from '@/types/sessions'
import { DEFAULT_POLL_POLICY, SOURCE_BASE_INTERVAL_MS } from '@/types/board'
import type { BoardSnapshot, RepositoryHealth, SourceKind } from '@/types/board'
import type { DenialEntry, DenialsRead, WorktreeEntry } from '@/types/local'
import type { RepositoryState } from '@/types/state'
import type { SessionKey } from '@/types/hosting'
import type { InterruptedStage } from '@/types/stage'
import { reconcileRepository } from '@/main/state/reconcile'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { FIXTURE_REPOSITORIES, GADGETS_ID, GADGETS_VOCABULARY_REPORT, LEGACY_SITE_ID, WIDGETS_ID, WIDGETS_VOCABULARY_REPORT } from './repos'
import type { RepoId } from '@/utils/repos'
import type { FixtureScenario } from '@/types/fixtures'
import { VIEWER, itemSeedsFor } from './board-seeds'
import type { ItemSeed } from './board-seeds'

function offsetMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

export function widgetsEntry() {
  const entry = FIXTURE_REPOSITORIES.find((repository) => repository.id === WIDGETS_ID)
  if (entry === undefined || !('config' in entry)) throw new Error('fixtures: acme/widgets is missing its resolved config')
  return entry
}

function legacySiteEntry() {
  const entry = FIXTURE_REPOSITORIES.find((repository) => repository.id === LEGACY_SITE_ID)
  if (entry === undefined || 'config' in entry) throw new Error('fixtures: acme/legacy-site unexpectedly resolved as ready')
  return entry
}

function gadgetsEntry() {
  const entry = FIXTURE_REPOSITORIES.find((repository) => repository.id === GADGETS_ID)
  if (entry === undefined || !('config' in entry)) throw new Error('fixtures: acme/gadgets is missing its resolved config')
  return entry
}

export function repositoryHealth(repoId: RepoId, now: Date): RepositoryHealth {
  const at = now.toISOString()
  const source = (kind: SourceKind) => ({ lastSuccessAt: at, lastAttemptAt: at, consecutiveFailures: 0, lastError: null, intervalMs: SOURCE_BASE_INTERVAL_MS[kind], deferredUntil: null })
  return { repoId, github: source('github'), sessions: source('sessions'), worktrees: source('worktrees'), denials: source('denials') }
}

function pipelineItemsFor(now: Date, vocabulary: LabelVocabulary, seeds: readonly ItemSeed[]): readonly PipelineItem[] {
  return seeds.map((seed) => {
    const matchedKeys: readonly LabelKey[] = ['marker', seed.stageKey]
    const labels = matchedKeys.map((key) => labelName(vocabulary, key)).filter((name): name is string => name !== undefined)
    const isPr = seed.kind === 'pull-request'
    const history = seed.history ?? [{ key: seed.stageKey, actor: VIEWER, offsetMinutes: -10 }]
    const labelEvents: readonly LabelEventNode[] = history
      .map((move): { label: string; actor: string | null; at: string } | undefined => {
        const name = labelName(vocabulary, move.key)
        return name === undefined ? undefined : { label: name, actor: move.actor, at: offsetMinutes(now, move.offsetMinutes) }
      })
      .filter((event): event is LabelEventNode => event !== undefined)
    const updatedAt = offsetMinutes(now, seed.updatedMinutesAgo ?? (history[history.length - 1]?.offsetMinutes ?? -10))
    return {
      repo: 'acme/widgets',
      kind: seed.kind,
      number: seed.number,
      title: seed.title,
      url: `https://github.com/acme/widgets/${isPr ? 'pull' : 'issues'}/${String(seed.number)}`,
      body: seed.body ?? '',
      state: 'OPEN',
      mergedAt: null,
      updatedAt,
      assignees: seed.assignees ?? [VIEWER],
      labels,
      matchedKeys,
      labelEvents,
      headRefOid: isPr ? `fixture-sha-${String(seed.number)}` : null,
      mergeable: isPr ? (seed.mergeable ?? 'MERGEABLE') : null,
      reviews: isPr ? [] : null,
      comments: isPr ? (seed.comments ?? []).map((c) => ({ body: c.body, createdAt: offsetMinutes(now, c.offsetMinutes) })) : null,
      checkRollup: isPr ? [] : null,
      blockers: isPr ? null : (seed.blockers ?? { ok: true, open: [], shown: 0, total: 0 }),
      blockerComments: isPr || seed.stageKey !== 'blocked' ? null : (seed.blockerComments ?? []).map((c) => ({ body: c.body, createdAt: offsetMinutes(now, c.offsetMinutes), url: `https://github.com/acme/widgets/issues/${String(seed.number)}#issuecomment-1` })),
    }
  })
}

function queriedLabelsFor(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label) => ({ key: label.key, name: label.name, source: label.source }))
}

function readyRepositoryState(now: Date, scenario: FixtureScenario): RepositoryState {
  const entry = widgetsEntry()
  const vocabulary = entry.config.vocabulary
  const items = pipelineItemsFor(now, vocabulary, itemSeedsFor(scenario))

  const pipelineFetch: PipelineFetch = {
    ok: true,
    items,
    queried: queriedLabelsFor(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: WIDGETS_VOCABULARY_REPORT,
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: offsetMinutes(now, 60), limit: 5000 },
    viewer: VIEWER,
    fetchedAt: now.toISOString(),
  }

  // The one agent a reconciled item attaches to in this fixture, so the board shows an in-flight row with a real agent behind it.
  const agent: AgentRecord = {
    sessionId: 'fixture-session-impl-38',
    repoId: WIDGETS_ID,
    agentId: 'fixture-agent-impl-38',
    agentType: 'port:impl-agent',
    stage: 'impl-agent',
    model: 'sonnet',
    description: '#38 retry failed webhook deliveries',
    itemNumber: 38,
    worktreePath: null,
    worktreeBranch: null,
    spawnDepth: 1,
    lastActivityAt: offsetMinutes(now, -2),
    idleMs: 2 * 60_000,
    activity: 'active',
  }

  return reconcileRepository({
    entry,
    pipelineFetch,
    itemsByNumberFetch: null,
    repoSessions: { agents: [agent], sessions: scenario === 'empty' ? [] : [operatorSession(now)], available: true, freshness: { at: now.toISOString() } },
    worktrees: { ok: true, mainPath: '/home/you/src/widgets', entries: scenario === 'empty' ? [] : [OPERATOR_WORKTREE], subjectsAvailable: true, readAt: now.toISOString() },
    denials: widgetsDenialsRead(now, '/home/you/src/widgets/.agents/denials.log'),
  })
}

const OPERATOR_WORKTREE_PATH = '/home/you/src/widgets/.claude/worktrees/impl-46'

/** The operator's own worktree on the linked ticket's branch, so a hand-opened session in it lands on the ticket. */
const OPERATOR_WORKTREE: WorktreeEntry = {
  path: OPERATOR_WORKTREE_PATH,
  isMain: false,
  branch: '46-last-sync-time',
  head: 'c3d4e5f',
  detached: false,
  bare: false,
  locked: false,
  lockReason: null,
  prunable: false,
  prunableReason: null,
  producer: 'operator',
  insideMain: true,
  correlation: { number: 46, rung: 'branch-name' },
  unresolved: null,
}

/** Last active between the pull request's revision starting and its second review being queued. */
function operatorSession(now: Date): SessionRecord {
  return {
    sessionId: 'fixture-operator-46',
    repoId: WIDGETS_ID,
    cwd: OPERATOR_WORKTREE_PATH,
    worktreePath: OPERATOR_WORKTREE_PATH,
    role: 'other',
    roleEvidence: null,
    itemNumber: null,
    customTitle: 'Tidy the sync header copy',
    summary: null,
    firstPrompt: null,
    gitBranch: '46-last-sync-time',
    lastActivityAt: offsetMinutes(now, -40),
    idleMs: 40 * 60_000,
    activity: 'dormant',
    agentIds: [],
  }
}

function denialEntry(raw: DenialEntry['raw'], timestamp: string, decision: DenialEntry['decision'], actor: DenialEntry['actor'], subject: string): DenialEntry {
  return { raw, form: 'current', timestamp, decision, actor, subject }
}

/** The newest 8 lines of a longer log: one burst (three `impl-agent` denies on the same command), one unknown session, and a mix of misses/gate-clear/hook-error so the meta strip and both groupings have something to show. `capped: true` with `summary` counting a larger whole-file total than these entries alone. */
function widgetsDenialsRead(now: Date, path: string): DenialsRead {
  const entries: readonly DenialEntry[] = [
    denialEntry('l1', offsetMinutes(now, -25), 'deny', { kind: 'stage-agent', agent: 'impl-agent' }, 'node scripts/checks.ts'),
    denialEntry('l2', offsetMinutes(now, -24), 'deny', { kind: 'stage-agent', agent: 'impl-agent' }, 'node scripts/checks.ts'),
    denialEntry('l3', offsetMinutes(now, -23), 'deny', { kind: 'stage-agent', agent: 'impl-agent' }, 'node scripts/checks.ts'),
    denialEntry('l4', offsetMinutes(now, -20), 'miss', { kind: 'subagent', agentType: 'gh' }, 'gh pr list --repo acme/widgets'),
    denialEntry('l5', offsetMinutes(now, -18), 'deny', { kind: 'session', sessionId: 'session-not-on-this-machine' }, 'git push origin main'),
    denialEntry('l6', offsetMinutes(now, -12), 'miss', { kind: 'stage-agent', agent: 'review-agent' }, 'git status'),
    denialEntry('l7', offsetMinutes(now, -6), 'gate-clear', { kind: 'stage-agent', agent: 'revise-agent' }, 'gh issue edit 44'),
    denialEntry('l8', offsetMinutes(now, -2), 'hook-error', { kind: 'unattributed', raw: '' }, 'guard hook crashed'),
  ]
  return {
    ok: true,
    present: true,
    path,
    entries,
    summary: { agentDenials: 10, railDenials: 3, misses: 15, gateClears: 2, hookErrors: 1, legacy: 0, malformed: 0, total: 31 },
    capped: true,
    readAt: now.toISOString(),
  }
}

export function notReadyRepositoryState(): RepositoryState {
  const entry = legacySiteEntry()
  return { ok: false, repoId: entry.id, displayName: entry.displayName, reason: 'not-ready', problem: entry.problem }
}

// acme/gadgets: a third, ready repository with no items, whose own GitHub
// read carries no vocabulary label at all, so its Overview renders mis-resolved.
export function gadgetsRepositoryState(now: Date): RepositoryState {
  const entry = gadgetsEntry()
  const vocabulary = entry.config.vocabulary

  const pipelineFetch: PipelineFetch = {
    ok: true,
    items: [],
    queried: queriedLabelsFor(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: GADGETS_VOCABULARY_REPORT,
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4987, resetAt: offsetMinutes(now, 60), limit: 5000 },
    viewer: VIEWER,
    fetchedAt: now.toISOString(),
  }

  return reconcileRepository({
    entry,
    pipelineFetch,
    itemsByNumberFetch: null,
    repoSessions: { agents: [], sessions: [], available: true, freshness: { at: now.toISOString() } },
    worktrees: { ok: true, mainPath: '/home/you/src/gadgets', entries: [], subjectsAvailable: true, readAt: now.toISOString() },
    denials: { ok: true, present: false, path: '/home/you/src/gadgets/.agents/denials.log', readAt: now.toISOString() },
  })
}

/** `tick` is built with the real `planTick` over a fresh ledger, same as the real app gets on every restart. No dispatcher is wired in fixture mode — nothing in this module spawns anything. */
export function fixtureBoardSnapshot(now: Date, scenario: FixtureScenario = 'populated'): BoardSnapshot {
  const ready = readyRepositoryState(now, scenario)
  const notReady = notReadyRepositoryState()
  const gadgets = gadgetsRepositoryState(now)
  const readyEntry = widgetsEntry()
  const gadgetsEntryConfig = gadgetsEntry()

  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  const nextDecisionAt = new Date(now.getTime() + SOURCE_BASE_INTERVAL_MS.github)

  // Stands in for the earlier tick a fresh ledger never saw, so the stalled seed's first observation here classifies as a reset rather than a first sighting.
  if (scenario !== 'empty') ledger.advance(WIDGETS_ID, 54, { class: 'suspect', nextState: 'suspect', nextResets: 0 })

  const tickParams = { ledger, unknownStreaks, nextDecisionAt, now: () => now, reviewCycleCap: readyEntry.config.reviewCycleCap, startedTasks: [], refreshMemo, checkDispositions: readyEntry.config.checkDispositions, holdSessionRequired: true }
  const gadgetsTickParams = { ...tickParams, reviewCycleCap: gadgetsEntryConfig.config.reviewCycleCap, checkDispositions: gadgetsEntryConfig.config.checkDispositions }
  const tick = [planTick({ repository: ready, ...tickParams }), planTick({ repository: notReady, ...tickParams }), planTick({ repository: gadgets, ...gadgetsTickParams })]

  return {
    state: {
      repositories: [ready, notReady, gadgets],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: now.toISOString() },
      readAt: now.toISOString(),
    },
    health: [repositoryHealth(WIDGETS_ID, now), repositoryHealth(GADGETS_ID, now)],
    policy: DEFAULT_POLL_POLICY,
    tick,
    // acme/widgets reads `dispatching` — the ordinary, nothing-paused state a fresh registration starts in.
    runStates: { store: { kind: 'loaded' }, repositories: [{ repoId: WIDGETS_ID, state: 'dispatching', since: now.toISOString() }] },
    nextWakeupAt: nextDecisionAt.toISOString(),
    emittedAt: now.toISOString(),
    dispatch: [
      {
        repoId: WIDGETS_ID,
        owner: 'app',
        state:
          scenario === 'empty'
            ? { kind: 'idle' }
            : {
                kind: 'active',
                recent: [
                  {
                    agent: 'impl',
                    number: 38,
                    kind: 'issue',
                    trigger: 'planApproved',
                    state: 'started',
                    at: offsetMinutes(now, -2),
                    detail: null,
                    outcome: null,
                    sessionKey: 'fixture-stage-impl-38' as SessionKey,
                    claudeSessionId: 'fixture-session-impl-38',
                    operatorJoinedAt: offsetMinutes(now, -1),
                  },
                  {
                    agent: 'plan',
                    number: 38,
                    kind: 'issue',
                    trigger: 'ready',
                    state: 'ended',
                    at: offsetMinutes(now, -30),
                    detail: null,
                    outcome: { kind: 'completed', detail: null, costUsd: 0.42, resetsAt: null, worktree: 'removed', operatorJoined: false },
                    sessionKey: null,
                    claudeSessionId: 'fixture-session-plan-38',
                    operatorJoinedAt: null,
                  },
                ],
              },
        runState: 'dispatching',
        ownedSince: now.toISOString(),
        unreadableMessage: null,
        budget: {
          line: null,
          problem: null,
          costUsd: null,
          notes: scenario === 'empty' ? [] : [{ kind: 'escalated', number: 44, needsHumanLabel: LABEL_DEFAULTS.find((def) => def.key === 'needsHuman')?.name ?? 'needsHuman', commentFailedMessage: null }],
        },
        observed: [],
        denials: [],
        interrupted: scenario === 'empty' ? [] : interruptedStages(now),
      },
    ],
    autoPlan: [],
  }
}

/** Three sessions stopped by the same usage limit, plus one crash and one finished session whose worktree would not go — Needs you shows the collapsed line beside two ordinary Interrupted rows. */
function interruptedStages(now: Date): readonly InterruptedStage[] {
  const resetsAt = offsetMinutes(now, 95)
  const stopped = (id: string, number: number, agent: InterruptedStage['agent'], reason: InterruptedStage['reason'], minutesAgo: number): InterruptedStage => ({
    id,
    repoId: WIDGETS_ID,
    agent,
    number,
    kind: agent === 'revise' ? 'pull-request' : 'issue',
    trigger: agent === 'plan' ? 'ready' : agent === 'revise' ? 'needsRevision' : 'planApproved',
    inFlight: agent === 'plan' ? 'planning' : agent === 'revise' ? 'revising' : 'inProgress',
    model: agent === 'plan' ? 'opus' : 'sonnet',
    claudeSessionId: `fixture-session-${id}`,
    worktree: { path: `/home/you/src/widgets/.claude/worktrees/session-${id}`, branch: `session/${id}`, baseSha: 'abc1234' },
    startedAt: offsetMinutes(now, -minutesAgo - 20),
    interruptedAt: offsetMinutes(now, -minutesAgo),
    reason,
    detail: reason === 'cleanup-failed' ? 'it has uncommitted changes' : null,
    resetsAt: reason === 'usage-limit' ? resetsAt : null,
    costUsd: 1.1,
  })
  return [
    stopped('limit-38', 38, 'impl', 'usage-limit', 12),
    stopped('limit-36', 36, 'impl', 'usage-limit', 11),
    stopped('limit-52', 52, 'plan', 'usage-limit', 10),
    stopped('crash-35', 35, 'revise', 'crash', 25),
    stopped('cleanup-41', 41, 'revise', 'cleanup-failed', 18),
  ]
}
