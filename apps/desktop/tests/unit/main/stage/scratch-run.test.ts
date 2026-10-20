import type { HostedQuery } from '@/main/hosting/sdk'
import type { HostedSdk } from '@/main/hosting/sdk'
import type { StageLauncherHandle } from '@/types/stage'

// A scratch-repo run takes one ticket from `ready` to an opened PR entirely through stage sessions, against a fake SDK; only the outer edges (SDK, git, worktrees, GitHub, ownership, the stage registry, the budget gate) are faked.
import { describe, expect, it, vi } from 'vitest'
import { labelName, resolveVocabulary, verifyVocabulary } from '@/utils/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { PipelineFetch, PipelineItem, QueriedLabel, ResolvedItem } from '@/types/github'
import { DEFAULT_POLL_POLICY } from '@/types/board'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { Options } from '@/main/hosting/sdk'
import { createHostedStore } from '@/main/hosting/store'
import { createInMemoryHostingPersistence } from '@/main/hosting/persist'
import { createStageLauncher } from '@/main/stage/launcher'

import { createStageRegistry } from '@/main/stage/registry'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import type { Dispatcher } from '@/types/dispatch'
import type { StageDenial } from '@/types/stage'
import { createDispatchLedger, createForceDispatch, createRefreshMemo, createUnknownStreaks } from '@/main/tick/ledger'
import { planTick } from '@/main/tick/plan'
import { reconcileRepository } from '@/main/state/reconcile'
import type { ReadyEntry } from '@/types/actions'
import type { CreateStageWorktreeResult, RemoveSessionWorktreeOutcome } from '@/types/workspace'

const REPO_ID = 'repo-scratch' as RepoId
const VIEWER = 'op'
const NOW_ISO = '2026-01-01T00:00:00.000Z'
const VOCABULARY: LabelVocabulary = resolveVocabulary({})

function readyEntry(): ReadyEntry {
  return {
    id: REPO_ID,
    path: '/repo',
    displayName: 'o/scratch',
    status: 'ready',
    config: {
      repo: 'o/scratch',
      owner: 'o',
      name: 'scratch',
      branches: { integration: 'dev', production: 'main' },
      commands: { worktrees: null, budget: null },
      concurrency: { sharedFiles: [], overlapThreshold: 2 },
      sessionRequiredPaths: ['CLAUDE.md', '.claude/**'],
      checkDispositions: {},
      overrides: [],
      models: { plan: 'opus', impl: 'sonnet', review: 'sonnet', revise: 'sonnet' },
      modules: { approvalGate: true, release: true, scope: true },
      reviewCycleCap: 5,
      vocabulary: VOCABULARY,
    },
    diagnostics: [],
  }
}

/** `#N`'s current labels, the fake "GitHub" every read in this test goes through. */
type LabelMap = Map<number, Set<LabelKey>>
type PrMap = Map<number, { closes: number; labels: Set<LabelKey> }>

function moveLabel(labels: LabelMap, number: number, from: LabelKey, to: LabelKey): void {
  const set = labels.get(number)
  if (set === undefined) throw new Error(`scratch-run fake: #${String(number)} has no labels`)
  set.delete(from)
  set.add(to)
}

function namesOf(vocabulary: LabelVocabulary, keys: Iterable<LabelKey>): readonly string[] {
  const names: string[] = []
  for (const key of keys) {
    const name = labelName(vocabulary, key)
    if (name !== undefined) names.push(name)
  }
  return names
}

function queriedLabelsFor(vocabulary: LabelVocabulary): readonly QueriedLabel[] {
  return vocabulary.labels.map((label, index) => ({ key: label.key, name: label.name, source: label.source, issueAlias: `i${String(index)}`, prAlias: `p${String(index)}` }))
}

function pipelineItemsFor(vocabulary: LabelVocabulary, labels: LabelMap, prs: PrMap): readonly PipelineItem[] {
  const issues: PipelineItem[] = [...labels.entries()].map(([number, keys]) => ({
    repo: 'o/scratch',
    kind: 'issue',
    number,
    title: `issue ${String(number)}`,
    url: `https://example.test/issues/${String(number)}`,
    body: '',
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    assignees: [VIEWER],
    labels: namesOf(vocabulary, keys),
    matchedKeys: [...keys],
    labelEvents: [],
    headRefOid: null,
    mergeable: null,
    reviews: null,
    comments: null,
    checkRollup: null,
  }))
  const prItems: PipelineItem[] = [...prs.entries()].map(([number, pr]) => ({
    repo: 'o/scratch',
    kind: 'pull-request',
    number,
    title: `pr ${String(number)}`,
    url: `https://example.test/pull/${String(number)}`,
    body: `Closes #${String(pr.closes)}`,
    state: 'OPEN',
    mergedAt: null,
    updatedAt: null,
    assignees: [VIEWER],
    labels: namesOf(vocabulary, pr.labels),
    matchedKeys: [...pr.labels],
    labelEvents: [],
    headRefOid: `sha-${String(number)}`,
    mergeable: 'MERGEABLE',
    reviews: [],
    comments: [],
    checkRollup: [],
  }))
  return [...issues, ...prItems]
}

function buildPipelineFetch(vocabulary: LabelVocabulary, labels: LabelMap, prs: PrMap): PipelineFetch {
  return {
    ok: true,
    items: pipelineItemsFor(vocabulary, labels, prs),
    queried: queriedLabelsFor(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: verifyVocabulary(vocabulary, { ok: true, names: vocabulary.labels.map((label) => label.name) }),
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: NOW_ISO, limit: 5000 },
    viewer: VIEWER,
    fetchedAt: NOW_ISO,
  }
}

/** `push` delivers the next message to whichever `next()` is currently waiting — copied from `hosting/handle.test.ts`'s own `fakeQuery` shape. */
function fakeQuery() {
  let pendingResolve: ((result: IteratorResult<unknown>) => void) | null = null
  const queue: unknown[] = []
  let done = false

  const query: HostedQuery = {
    interrupt: vi.fn(() => Promise.resolve({ still_queued: [] })),
    close: vi.fn(),
    supportedCommands: vi.fn(() => Promise.resolve([])),
    supportedAgents: vi.fn(() => Promise.resolve([])),
    setPermissionMode: vi.fn(() => Promise.resolve()),
    setModel: vi.fn(() => Promise.resolve()),
    applyFlagSettings: vi.fn(() => Promise.resolve()),
    supportedModels: vi.fn(() => Promise.resolve([])),
    stopTask: vi.fn(() => Promise.resolve()),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
          if (done) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => {
            pendingResolve = resolve
          })
        },
      }
    },
  }

  return {
    query,
    push(message: unknown) {
      if (pendingResolve !== null) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: false, value: message })
      } else {
        queue.push(message)
      }
    },
    finish() {
      done = true
      if (pendingResolve !== null) {
        const resolve = pendingResolve
        pendingResolve = null
        resolve({ done: true, value: undefined })
      }
    },
  }
}

/** Branches on `options.agent`; each scripted session moves the fake "GitHub" the way the real stage agent would, then emits init + a success result. Any other agent, or a missing one, throws loudly. */
function createFakeSdk(seen: Options[], labels: LabelMap, prs: PrMap): HostedSdk {
  return {
    query: ({ prompt, options }) => {
      if (options === undefined) throw new Error('scratch-run fake: query called with no options')
      if (options.agent !== 'port:plan-agent' && options.agent !== 'port:impl-agent') {
        throw new Error(`scratch-run fake: unexpected agent ${String(options.agent)}`)
      }
      if (typeof prompt === 'string') throw new Error('scratch-run fake: expected a streaming prompt, got a string')
      seen.push(options)
      const fake = fakeQuery()
      void (async () => {
        await prompt[Symbol.asyncIterator]().next() // the first user turn — store.send() really went through the handle
        if (options.agent === 'port:plan-agent') {
          moveLabel(labels, 7, 'ready', 'planning')
          moveLabel(labels, 7, 'planning', 'planReview')
          fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-plan' })
          fake.push({ type: 'result', subtype: 'success', is_error: false, result: 'Plan written.', total_cost_usd: 0.4 })
        } else {
          moveLabel(labels, 7, 'planApproved', 'inProgress')
          prs.set(8, { closes: 7, labels: new Set<LabelKey>(['marker', 'readyForReview']) })
          moveLabel(labels, 7, 'inProgress', 'prOpened')
          fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-impl' })
          fake.push({ type: 'result', subtype: 'success', is_error: false, result: 'PR opened.', total_cost_usd: 0.6 })
        }
        fake.finish()
      })()
      return fake.query
    },
    renameSession: vi.fn(() => Promise.resolve(undefined)),
  }
}

describe('scratch run — ready to opened PR through real stage sessions', () => {
  it('composes the real store, launcher and dispatcher against a fake SDK', async () => {
    const entry = readyEntry()
    const labels: LabelMap = new Map([[7, new Set<LabelKey>(['marker', 'ready'])]])
    const prs: PrMap = new Map()
    const seen: Options[] = []
    const listedSnapshots: HostedSessionSnapshot[] = []
    const createdWorktrees: string[] = []
    const removedWorktrees: { path: string; force: boolean }[] = []
    let worktreeCounter = 0

    function createWorktree(): Promise<CreateStageWorktreeResult> {
      worktreeCounter += 1
      const path = `/scratch/session-${String(worktreeCounter)}`
      createdWorktrees.push(path)
      return Promise.resolve({ ok: true, path, branch: `session-${String(worktreeCounter)}`, baseSha: 'base-sha', baseLabel: `session-${String(worktreeCounter)}` })
    }
    function removeWorktree(path: string, force: boolean): Promise<RemoveSessionWorktreeOutcome> {
      removedWorktrees.push({ path, force })
      return Promise.resolve({ outcome: 'removed' })
    }

    function fetchItemsByNumber(params: { readonly numbers: readonly number[] }): Promise<{ ok: true; resolved: readonly ResolvedItem[]; unavailable: readonly number[]; fetchedAt: string }> {
      const resolved: ResolvedItem[] = []
      const unavailable: number[] = []
      for (const number of params.numbers) {
        const set = labels.get(number)
        if (set === undefined) {
          unavailable.push(number)
          continue
        }
        resolved.push({ number, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: `issue ${String(number)}`, url: `https://example.test/issues/${String(number)}`, labels: namesOf(VOCABULARY, set), assignees: [VIEWER], headRefName: null })
      }
      return Promise.resolve({ ok: true, resolved, unavailable, fetchedAt: NOW_ISO })
    }

    // Late-binding, the same construction order `main/ipc.ts` uses: onStatus closes over stageLauncher,
    // stageLauncher's onOutcome/onDenial close over dispatcherRef — both assigned right after.
    let dispatcherRef: Dispatcher | null = null

    const store = createHostedStore({
      getSdk: () => Promise.resolve(createFakeSdk(seen, labels, prs)),
      resolveClaudeExecutable: () => Promise.resolve({ ok: true, path: '/usr/local/bin/claude' }),
      readCredentialsTell: () => Promise.resolve({ present: false, expiresAt: null, hasRefreshToken: false }),
      listSessionsForFork: () => Promise.resolve({ ok: true, sessions: [] }),
      env: {},
      platform: 'linux',
      now: () => Date.now(),
      onEvent: () => undefined,
      onStatus: (snapshot) => {
        listedSnapshots.push(snapshot)
        stageLauncher.observe(snapshot)
      },
      onEntries: () => undefined,
      resolvePluginRequest: () => Promise.resolve({ source: 'installed' }),
      readExpectedComponents: () => Promise.resolve(null),
      readStageEditAllow: () => Promise.resolve([]),
      samePath: (a, b) => a === b,
      persistence: createInMemoryHostingPersistence(),
      removeWorktree,
      readHistory: () => Promise.resolve({ kind: 'none' }),
    })

    const stageRegistry = createStageRegistry({
      path: '/repo/.agents/stage-sessions.json',
      readJson: () => Promise.resolve({ ok: false, kind: 'not-found', message: 'none' }),
      writeJsonAtomic: () => Promise.resolve({ ok: true, value: undefined }),
      now: () => new Date(NOW_ISO),
    })
    await stageRegistry.load()

    const stageLauncher: StageLauncherHandle = createStageLauncher({
      store,
      git: () => Promise.reject(new Error('git should not be invoked in this test')),
      createWorktree,
      removeWorktree,
      releaseBranch: () => Promise.resolve('deleted'),
      sweepBranches: () => Promise.resolve(undefined),
      now: () => new Date(NOW_ISO),
      onOutcome: (repoId, sessionKey, outcome) => dispatcherRef?.recordOutcome(repoId, sessionKey, outcome),
      registry: stageRegistry,
      onDenial: (repoId, denial: StageDenial) => dispatcherRef?.recordDenial(repoId, denial),
      newId: () => `id-${String(Math.random())}`,
    })

    const ledger = createDispatchLedger()
    const unknownStreaks = createUnknownStreaks()
    const refreshMemo = createRefreshMemo()
    const forceDispatch = createForceDispatch()

    const dispatcher = createDispatcher({
      store,
      ledger,
      launch: stageLauncher,
      runState: () => 'dispatching',
      readOwnership: () => Promise.resolve({ kind: 'app', since: NOW_ISO, path: '/repo/.agents/cockpit.json', readAt: NOW_ISO }),
      takeOwnership: () => Promise.resolve({ ok: true, path: '/repo/.agents/cockpit.json' }),
      fetchItemsByNumber,
      listRepositories: () => Promise.resolve({ ok: true, repositories: [entry] }),
      registryDeps: { registryDir: '/registry', git: () => Promise.reject(new Error('unused')), chooseDirectory: () => Promise.resolve(null) },
      budget: {
        reset: () => {
          throw new Error('budget.reset should not be invoked when commands.budget is null')
        },
        sweep: () => {
          throw new Error('budget.sweep should not be invoked when commands.budget is null')
        },
        check: () => {
          throw new Error('budget.check should not be invoked when commands.budget is null')
        },
      },
      escalate: () => {
        throw new Error('escalate should not be invoked when commands.budget is null')
      },
      writeObservation: () => {
        throw new Error('writeObservation should not be invoked in this scenario')
      },
      refreshMemo,
      forceDispatch,
      requestRead: () => undefined,
      dirs: { audit: '/audit', scratch: '/scratch' },
      onChange: () => undefined,
      now: () => new Date(NOW_ISO),
      interrupted: () => [],
    })
    dispatcherRef = dispatcher

    async function tick(): Promise<void> {
      const pipelineFetch = buildPipelineFetch(VOCABULARY, labels, prs)
      const repoState = reconcileRepository({
        entry,
        pipelineFetch,
        itemsByNumberFetch: null,
        repoSessions: { agents: [], sessions: [], available: true, freshness: { at: NOW_ISO } },
        worktrees: { ok: true, mainPath: '/repo', entries: [], subjectsAvailable: true, readAt: NOW_ISO },
        denials: { ok: true, present: false, path: '/repo/.agents/denials.log', readAt: NOW_ISO },
      })
      const tickReport = planTick({
        repository: repoState,
        ledger,
        unknownStreaks,
        nextDecisionAt: new Date(NOW_ISO),
        now: () => new Date(NOW_ISO),
        reviewCycleCap: entry.config.reviewCycleCap,
        startedTasks: [],
        refreshMemo,
        checkDispositions: entry.config.checkDispositions,
        holdSessionRequired: dispatcher.holdsSessionRequired(REPO_ID),
      })
      const snapshot: BoardSnapshot = {
        state: { repositories: [repoState], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: NOW_ISO }, readAt: NOW_ISO },
        health: [],
        policy: DEFAULT_POLL_POLICY,
        tick: [tickReport],
        runStates: { store: { kind: 'loaded' }, repositories: [{ repoId: REPO_ID, state: 'dispatching', since: NOW_ISO }] },
        nextWakeupAt: null,
        emittedAt: NOW_ISO,
        dispatch: [],
      }
      await dispatcher.consider(snapshot)
    }

    function recentOf() {
      const state = dispatcher.status()[0]?.state
      return state?.kind === 'active' ? state.recent : []
    }

    function endedCompletedCount(): number {
      return recentOf().filter((r) => r.state === 'ended' && r.outcome?.kind === 'completed').length
    }

    // Each poll re-ticks: a stage record only moves to 'ended' on the considerRepo pass after its
    // session is actually gone, so observing settle's own completion means re-ticking, not just waiting.
    async function waitForEndedCompleted(count: number): Promise<void> {
      await vi.waitFor(async () => {
        await tick()
        expect(endedCompletedCount()).toBeGreaterThanOrEqual(count)
      })
    }

    await tick()
    await waitForEndedCompleted(1)

    // The human gate hasn't been applied yet, so nothing new launches.
    await tick()
    expect(seen).toHaveLength(1)

    moveLabel(labels, 7, 'planReview', 'planApproved')
    await tick()
    await waitForEndedCompleted(2)

    // No actionable item remains after the impl stage settles.
    const beforeFinal = seen.length
    await tick()
    expect(seen).toHaveLength(beforeFinal)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ agent: 'port:plan-agent', model: 'opus', permissionMode: 'default' })
    expect(seen[1]).toMatchObject({ agent: 'port:impl-agent', model: 'sonnet', permissionMode: 'default' })

    expect(listedSnapshots.every((s) => s.stage !== null)).toBe(true)

    expect([...(labels.get(7) ?? [])]).toContain('prOpened')
    expect([...(prs.get(8)?.labels ?? [])]).toContain('readyForReview')

    expect(createdWorktrees).toHaveLength(2)
    expect(removedWorktrees).toHaveLength(2)
    expect(removedWorktrees.every((r) => !r.force)).toBe(true)
    expect(removedWorktrees.map((r) => r.path).sort()).toEqual([...createdWorktrees].sort())

    const recent = recentOf()
    const ended = recent.filter((r) => r.state === 'ended')
    expect(ended).toHaveLength(2)
    for (const record of ended) {
      expect(record.outcome).toMatchObject({ kind: 'completed', worktree: 'removed' })
      expect(record.outcome?.costUsd).not.toBeNull()
    }
  })
})
