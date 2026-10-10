// Canned reads pass through the real, pure `reconcileRepository` and `planTick`, so a screenshot shows exactly what the real derivation produces. Every timestamp is `now` plus a fixed offset, so "5m ago" renders the same on every run.
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'
import type { PipelineFetch, PipelineItem, QueriedLabel } from '../../shared/github/types'
import type { AgentRecord } from '../../shared/sessions/types'
import { DEFAULT_POLL_POLICY, SOURCE_BASE_INTERVAL_MS } from '../../shared/board/types'
import type { BoardSnapshot, RepositoryHealth, SourceKind } from '../../shared/board/types'
import type { DenialEntry, DenialsRead } from '../../shared/local/types'
import type { RepositoryState } from '../../shared/state/types'
import { reconcileRepository } from '../state/reconcile'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '../tick/ledger'
import { planTick } from '../tick/plan'
import { FIXTURE_REPOSITORIES, GADGETS_ID, GADGETS_VOCABULARY_REPORT, LEGACY_SITE_ID, WIDGETS_ID, WIDGETS_VOCABULARY_REPORT } from './repos'
import type { RepoId } from '../../shared/repos'
import type { FixtureScenario } from './mode'

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

interface ItemSeed {
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly title: string
  readonly stageKey: LabelKey
  // Defaults to [VIEWER] — only the unowned-held seed overrides it.
  readonly assignees?: readonly string[]
}

/** One item per stage family the board groups by, so the screenshot shows every group non-empty, plus two seeds for the Needs you screen's own label-kinds. */
const POPULATED_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 41, title: 'Add CSV export to the reports page', stageKey: 'planReview' },
  { kind: 'issue', number: 38, title: 'Retry failed webhook deliveries', stageKey: 'inProgress' },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  { kind: 'pull-request', number: 36, title: 'Paginate the audit log', stageKey: 'approved' },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
  { kind: 'issue', number: 50, title: 'Rotate the webhook signing secret', stageKey: 'needsHuman' },
  { kind: 'issue', number: 51, title: 'Backfill order totals for Q3', stageKey: 'blocked' },
  // Unassigned and queued, so planTick's ownership partition holds it with reason 'unowned' — the Board's "Waiting on you" row needs one.
  { kind: 'issue', number: 52, title: 'Add a dark-mode icon for the tray', stageKey: 'ready', assignees: [] },
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

function pipelineItemsFor(vocabulary: LabelVocabulary, seeds: readonly ItemSeed[]): readonly PipelineItem[] {
  return seeds.map((seed) => {
    const matchedKeys: readonly LabelKey[] = ['marker', seed.stageKey]
    const labels = matchedKeys.map((key) => labelName(vocabulary, key)).filter((name): name is string => name !== undefined)
    const isPr = seed.kind === 'pull-request'
    return {
      repo: 'acme/widgets',
      kind: seed.kind,
      number: seed.number,
      title: seed.title,
      url: `https://github.com/acme/widgets/${isPr ? 'pull' : 'issues'}/${String(seed.number)}`,
      body: '',
      state: 'OPEN',
      mergedAt: null,
      assignees: seed.assignees ?? [VIEWER],
      labels,
      matchedKeys,
      headRefOid: isPr ? `fixture-sha-${String(seed.number)}` : null,
      mergeable: isPr ? 'MERGEABLE' : null,
      reviews: isPr ? [] : null,
      comments: isPr ? [] : null,
      checkRollup: isPr ? [] : null,
    }
  })
}

function queriedLabelsFor(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label, index) => ({ key: label.key, name: label.name, source: label.source, issueAlias: `i${String(index)}`, prAlias: `p${String(index)}` }))
}

function readyRepositoryState(now: Date, scenario: FixtureScenario): RepositoryState {
  const entry = widgetsEntry()
  const vocabulary = entry.config.vocabulary
  const items = pipelineItemsFor(vocabulary, itemSeedsFor(scenario))

  const pipelineFetch: PipelineFetch = {
    ok: true,
    items,
    queried: queriedLabelsFor(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: WIDGETS_VOCABULARY_REPORT,
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: offsetMinutes(now, 60) },
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
    repoSessions: { agents: [agent], sessions: [], available: true, freshness: { at: now.toISOString() } },
    worktrees: { ok: true, mainPath: '/home/you/src/widgets', entries: [], subjectsAvailable: true, readAt: now.toISOString() },
    denials: widgetsDenialsRead(now, '/home/you/src/widgets/.agents/denials.log'),
  })
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
    rateLimit: { cost: 1, remaining: 4987, resetAt: offsetMinutes(now, 60) },
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

  const tickParams = { ledger, unknownStreaks, nextDecisionAt, now: () => now, reviewCycleCap: readyEntry.config.reviewCycleCap, startedTasks: [], refreshMemo, checkDispositions: readyEntry.config.checkDispositions }
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
        state: { kind: 'idle' },
        runState: 'dispatching',
        ownedSince: now.toISOString(),
        unreadableMessage: null,
        budget: {
          line: null,
          problem: null,
          notes: scenario === 'empty' ? [] : [{ kind: 'escalated', number: 44, needsHumanLabel: LABEL_DEFAULTS.find((def) => def.key === 'needsHuman')?.name ?? 'needsHuman', commentFailedMessage: null }],
        },
        observed: [],
      },
    ],
  }
}
