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

const VIEWER = 'octo-dev'

function offsetMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

function widgetsEntry() {
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

function repositoryHealth(repoId: RepoId, now: Date): RepositoryHealth {
  const at = now.toISOString()
  const source = (kind: SourceKind) => ({ lastSuccessAt: at, lastAttemptAt: at, consecutiveFailures: 0, lastError: null, intervalMs: SOURCE_BASE_INTERVAL_MS[kind], deferredUntil: null })
  return { repoId, github: source('github'), sessions: source('sessions'), worktrees: source('worktrees'), denials: source('denials') }
}

interface StageMove {
  readonly key: LabelKey
  readonly actor: string
  readonly offsetMinutes: number
}

interface ItemSeed {
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly title: string
  readonly stageKey: LabelKey
  // Defaults to empty — a pull request's closing keyword is what links it to its issue.
  readonly body?: string
  // Defaults to [VIEWER] — only the unowned-held seed overrides it.
  readonly assignees?: readonly string[]
  // Defaults to a single move onto stageKey — the pagination item below walks a realistic multi-stage path instead.
  readonly history?: readonly StageMove[]
  // Minutes-ago offset for updatedAt — defaults to the last history entry's own offset.
  readonly updatedMinutesAgo?: number
  // A pull request's mergeability — defaults to 'MERGEABLE'; ignored for issues.
  readonly mergeable?: 'MERGEABLE' | 'CONFLICTING'
  // A pull request's comments — defaults to none; ignored for issues.
  readonly comments?: readonly { readonly body: string; readonly offsetMinutes: number }[]
}

const CURRENCY_ESCALATION = [
  '## Pipeline Escalation',
  '3 conflicts — 1 resolved automatically, 2 need a decision',
  '',
  '### Auto-resolved (reapplied on the next attempt)',
  '- `pnpm-lock.yaml` — regenerated from the base',
  '',
  '### D1 — `src/money.ts`',
  '**Ours:** rounds half-up in `roundCents`',
  '**Theirs:** rounds half-even in `roundCents`',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | half-up rounding | the base branch\'s half-even change |',
  '| **B take theirs** | half-even rounding | this PR\'s half-up change |',
  '| **C keep both** | both behaviours behind a flag | a single code path |',
  '',
  '**Recommendation: B** — the base already ships half-even to callers.',
  '',
  '### D2 — `src/format.ts`',
  '**Ours:** formats totals with two decimals',
  '**Theirs:** formats totals with the locale default',
  '',
  '| Option | Keeps | Loses |',
  '| --- | --- | --- |',
  '| **A take ours** | fixed two decimals | locale-aware formatting |',
  '| **B take theirs** | locale-aware formatting | fixed two decimals |',
  '| **C keep both rounding modes** | a `mode` argument on `formatTotal` | the one-argument signature |',
  '',
  '**Recommendation: C** — callers on both sides still need their own mode.',
].join('\n')

/** One item per stage family the board groups by, so the screenshot shows every group non-empty, plus two seeds for the Needs you screen's own label-kinds. */
const POPULATED_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 41, title: 'Add CSV export to the reports page', stageKey: 'planReview' },
  {
    kind: 'issue',
    number: 38,
    title: 'Retry failed webhook deliveries',
    stageKey: 'inProgress',
    // A multi-phase walk, so R6's phase list has every finished line plus a live current one to render.
    history: [
      { key: 'planning', actor: 'port-bot', offsetMinutes: -45 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -40 },
      { key: 'planApproved', actor: VIEWER, offsetMinutes: -35 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -2 },
    ],
  },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  {
    kind: 'pull-request',
    number: 36,
    title: 'Paginate the audit log',
    stageKey: 'approved',
    // A realistic multi-stage walk, so R7/R8 have a non-trivial phase history to render.
    history: [
      { key: 'ready', actor: 'octo-dev', offsetMinutes: -180 },
      { key: 'planning', actor: 'port-bot', offsetMinutes: -170 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -150 },
      { key: 'planApproved', actor: 'octo-dev', offsetMinutes: -140 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -130 },
      { key: 'prOpened', actor: 'port-bot', offsetMinutes: -60 },
      { key: 'approved', actor: 'octo-dev', offsetMinutes: -10 },
    ],
  },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
  // An issue and the pull request that closes it, so the Board folds them into one row; the unlabelled-body pull request above stays the one with no ticket.
  {
    kind: 'issue',
    number: 46,
    title: 'Show the last sync time in the header',
    stageKey: 'prOpened',
    history: [
      { key: 'planning', actor: 'port-bot', offsetMinutes: -170 },
      { key: 'planReview', actor: 'port-bot', offsetMinutes: -160 },
      { key: 'planApproved', actor: VIEWER, offsetMinutes: -150 },
      { key: 'inProgress', actor: 'port-bot', offsetMinutes: -140 },
      { key: 'prOpened', actor: 'port-bot', offsetMinutes: -90 },
    ],
  },
  {
    kind: 'pull-request',
    number: 47,
    title: 'Show the last sync time in the header',
    stageKey: 'reviewing',
    body: 'Closes #46',
    history: [
      { key: 'readyForReview', actor: 'port-bot', offsetMinutes: -90 },
      { key: 'reviewing', actor: 'port-bot', offsetMinutes: -80 },
      { key: 'needsRevision', actor: 'port-bot', offsetMinutes: -60 },
      { key: 'revising', actor: 'port-bot', offsetMinutes: -50 },
      { key: 'readyForReview', actor: 'port-bot', offsetMinutes: -30 },
      { key: 'reviewing', actor: 'port-bot', offsetMinutes: -10 },
    ],
  },
  // A rebase escalation with two decisions, so the Needs you screen's Unblock dialog has picks to show.
  { kind: 'pull-request', number: 37, title: 'Normalize currency rounding', stageKey: 'needsHuman', comments: [{ body: CURRENCY_ESCALATION, offsetMinutes: -8 }] },
  { kind: 'issue', number: 50, title: 'Rotate the webhook signing secret', stageKey: 'needsHuman' },
  { kind: 'issue', number: 51, title: 'Backfill order totals for Q3', stageKey: 'blocked' },
  // Unassigned and queued, so planTick's ownership partition holds it with reason 'unowned' — the Board's "Waiting on you" row needs one.
  { kind: 'issue', number: 52, title: 'Add a dark-mode icon for the tray', stageKey: 'ready', assignees: [] },
  // Conflicting against the base branch, so planTick's mergeability gate surfaces it as a Needs-you 'held' item.
  { kind: 'pull-request', number: 53, title: 'Upgrade the PDF renderer', stageKey: 'readyForReview', mergeable: 'CONFLICTING', updatedMinutesAgo: -5 },
  // No attached agent, so the dispatch ledger's unmatched read reaches the Needs-you 'stalled' classification.
  { kind: 'issue', number: 54, title: 'Migrate session storage to Redis', stageKey: 'inProgress', updatedMinutesAgo: -40 },
]

// Keeps only the routine, non-"needs you" seeds, so the Needs you screen renders its empty state while the Board stays non-empty.
const EMPTY_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 38, title: 'Retry failed webhook deliveries', stageKey: 'inProgress' },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
]

function itemSeedsFor(scenario: FixtureScenario): readonly ItemSeed[] {
  return scenario === 'empty' ? EMPTY_ITEM_SEEDS : POPULATED_ITEM_SEEDS
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

function notReadyRepositoryState(): RepositoryState {
  const entry = legacySiteEntry()
  return { ok: false, repoId: entry.id, displayName: entry.displayName, reason: 'not-ready', problem: entry.problem }
}

// acme/gadgets: a third, ready repository with no items, whose own GitHub
// read carries no vocabulary label at all, so its Overview renders mis-resolved.
function gadgetsRepositoryState(now: Date): RepositoryState {
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

/** Three sessions stopped by the same usage limit, plus one crash — Needs you shows the collapsed line beside an ordinary Interrupted row. */
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
    detail: null,
    resetsAt: reason === 'usage-limit' ? resetsAt : null,
    costUsd: 1.1,
  })
  return [stopped('limit-38', 38, 'impl', 'usage-limit', 12), stopped('limit-36', 36, 'impl', 'usage-limit', 11), stopped('limit-52', 52, 'plan', 'usage-limit', 10), stopped('crash-35', 35, 'revise', 'crash', 25)]
}
