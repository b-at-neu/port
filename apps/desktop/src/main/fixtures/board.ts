// Fixture mode's own canned board (#317) — the canned GitHub, session,
// worktree and denial reads pass through the real, pure `reconcileRepository`
// (`../state/reconcile`, never the `../state` barrel, which pulls in the
// watcher) and `planTick` (`../tick`), so a screenshot shows exactly what the
// real derivation produces. One populated scenario only — empty and error
// variants belong to the screen tickets that extend this module as they
// build those regions (ENGINEERING §7: no placeholder content for a later
// ticket). Every timestamp is `now` minus a fixed offset, so "5m ago" renders
// the same on every run, never "just now".
import { labelName } from '../../shared/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '../../shared/labels/vocabulary'
import { LABEL_DEFAULTS } from '../../shared/labels/defaults'
import type { PipelineFetch, PipelineItem, QueriedLabel } from '../../shared/github/types'
import type { AgentRecord } from '../../shared/sessions/types'
import type { RelayPending } from '../../shared/relay/types'
import { DEFAULT_POLL_POLICY, SOURCE_BASE_INTERVAL_MS } from '../../shared/board/types'
import type { BoardSnapshot, RepositoryHealth, SourceKind } from '../../shared/board/types'
import type { RepositoryState } from '../../shared/state/types'
import { reconcileRepository } from '../state/reconcile'
import { createDispatchLedger, createRefreshMemo, createUnknownStreaks } from '../tick/ledger'
import { planTick } from '../tick/plan'
import { FIXTURE_REPOSITORIES, LEGACY_SITE_ID, WIDGETS_ID, WIDGETS_VOCABULARY_REPORT } from './repos'
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

function repositoryHealth(now: Date): RepositoryHealth {
  const at = now.toISOString()
  const source = (kind: SourceKind) => ({ lastSuccessAt: at, lastAttemptAt: at, consecutiveFailures: 0, lastError: null, intervalMs: SOURCE_BASE_INTERVAL_MS[kind], deferredUntil: null })
  return { repoId: WIDGETS_ID, github: source('github'), sessions: source('sessions'), worktrees: source('worktrees'), denials: source('denials') }
}

interface ItemSeed {
  readonly kind: 'issue' | 'pull-request'
  readonly number: number
  readonly title: string
  readonly stageKey: LabelKey
}

/** #41 → `planReview`, #38 → `inProgress` (with its own active `impl-agent`
 *  below), #44 → `ready`, #36 (a pull request) → `approved`, #35 (a pull
 *  request) → `needsRevision` — one item per stage family the board groups
 *  by, so the screenshot shows every group non-empty. #315: #50 →
 *  `needsHuman` and #51 → `blocked` seed the Needs you screen's own two
 *  label-kinds the board itself does not otherwise exercise. */
const POPULATED_ITEM_SEEDS: readonly ItemSeed[] = [
  { kind: 'issue', number: 41, title: 'Add CSV export to the reports page', stageKey: 'planReview' },
  { kind: 'issue', number: 38, title: 'Retry failed webhook deliveries', stageKey: 'inProgress' },
  { kind: 'issue', number: 44, title: 'Show the build number in the footer', stageKey: 'ready' },
  { kind: 'pull-request', number: 36, title: 'Paginate the audit log', stageKey: 'approved' },
  { kind: 'pull-request', number: 35, title: 'Cache avatar thumbnails', stageKey: 'needsRevision' },
  { kind: 'issue', number: 50, title: 'Rotate the webhook signing secret', stageKey: 'needsHuman' },
  { kind: 'issue', number: 51, title: 'Backfill order totals for Q3', stageKey: 'blocked' },
]

// The empty scenario keeps only the routine, non-"needs you" seeds, so the
// Needs you screen renders its empty state while the Board stays non-empty.
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
      assignees: [VIEWER],
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

  // #38's own active `impl-agent` — the one agent a reconciled item attaches
  // to in this fixture, so the board shows an in-flight row with a real
  // agent behind it rather than every trigger-staged item looking the same.
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
    denials: { ok: true, present: false, path: '/home/you/src/widgets/.agents/denials.log', readAt: now.toISOString() },
  })
}

function notReadyRepositoryState(): RepositoryState {
  const entry = legacySiteEntry()
  return { ok: false, repoId: entry.id, displayName: entry.displayName, reason: 'not-ready', problem: entry.problem }
}

/** #315: #38's own `impl-agent` has a question waiting — the Needs you
 *  screen's `question` kind, matched onto the same row its `inProgress`
 *  label already produces. */
function pendingQuestion(now: Date): RelayPending {
  return {
    repoId: WIDGETS_ID,
    number: 38,
    stage: 'impl-agent',
    sessionId: 'fixture-session-impl-38',
    agentId: 'fixture-agent-impl-38',
    parentSessionLabel: 'cockpit session',
    agentLabel: 'impl-agent #38',
    lastActivityAt: offsetMinutes(now, -5),
    kind: 'questions',
    questions: [{ index: 0, text: 'Should the retry backoff be linear or exponential?' }],
  }
}

/** `tick` is built with the real `planTick`, over a fresh `createDispatchLedger`
 *  — a process-scoped ledger, same as the real app gets on every restart, so
 *  a single invocation never carries state across repositories. `relay`
 *  carries #38's own pending question (above); `dispatch` carries one
 *  `escalated` budget note on #44, the Needs you screen's own `budget` kind
 *  — no dispatcher is wired in fixture mode otherwise (PIPELINE.md's own "no
 *  gh or claude calls" rule applies here too: nothing in this module spawns
 *  anything). */
export function fixtureBoardSnapshot(now: Date, scenario: FixtureScenario = 'populated'): BoardSnapshot {
  const ready = readyRepositoryState(now, scenario)
  const notReady = notReadyRepositoryState()
  const readyEntry = widgetsEntry()

  const ledger = createDispatchLedger()
  const unknownStreaks = createUnknownStreaks()
  const refreshMemo = createRefreshMemo()
  const nextDecisionAt = new Date(now.getTime() + SOURCE_BASE_INTERVAL_MS.github)

  const tickParams = { ledger, unknownStreaks, nextDecisionAt, now: () => now, reviewCycleCap: readyEntry.config.reviewCycleCap, startedTasks: [], refreshMemo, checkDispositions: readyEntry.config.checkDispositions }
  const tick = [planTick({ repository: ready, ...tickParams }), planTick({ repository: notReady, ...tickParams })]

  return {
    state: {
      repositories: [ready, notReady],
      sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 1, scanMs: 1, scannedAt: now.toISOString() },
      readAt: now.toISOString(),
    },
    health: [repositoryHealth(now)],
    policy: DEFAULT_POLL_POLICY,
    tick,
    relay: { ok: true, pending: scenario === 'empty' ? [] : [pendingQuestion(now)], checked: 1, unreached: 0, scannedAt: now.toISOString() },
    // #314: acme/widgets reads `dispatching` — the ordinary, nothing-paused
    // state a fresh registration starts in.
    runStates: { store: { kind: 'loaded' }, repositories: [{ repoId: WIDGETS_ID, state: 'dispatching', since: now.toISOString() }] },
    nextWakeupAt: nextDecisionAt.toISOString(),
    emittedAt: now.toISOString(),
    dispatch: [
      {
        repoId: WIDGETS_ID,
        owner: 'app',
        state: { kind: 'idle' },
        runState: 'dispatching',
        claimedAt: now.toISOString(),
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
