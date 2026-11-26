import type { HostedQuery, HostedSdk, Options } from '@/main/platform/sdk'
import type { AppContext } from '@/main/app/context'

// A scratch-repo run takes one ticket from `ready` to an opened PR entirely through stage sessions, against a fake SDK; only the outer edges (SDK, git, worktrees, GitHub) are faked.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { labelName, resolveVocabulary, verifyVocabulary } from '@/utils/labels/vocabulary'
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { RepoId } from '@/utils/repos'
import type { PipelineFetch, PipelineItem, QueriedLabel, ResolvedItem } from '@/types/github'
import { ticketOf as stateTicketOf } from '../../../../support/tickets'
import { DEFAULT_POLL_POLICY } from '@/types/board'
import type { BoardSnapshot } from '@/types/board'
import type { HostedSessionSnapshot } from '@/types/hosting'
import { createHostedStore } from '@/main/sessions/hosting/store'
import { createInMemoryHostingPersistence } from '@/main/sessions/hosting/persist'
import { createStageLauncher } from '@/main/dispatch/stage/launcher'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { planTick } from '@/main/pipeline/tick/plan'
import { reconcileRepository } from '@/main/pipeline/board/reconcile'
import type { ReadyEntry } from '@/types/actions'
import type { WriteEventParams } from '@/types/writes'
import { boardSnapshot } from '../../../../support/board-snapshot'
import { labelMapStore } from '../../../../support/label-map-store'
import { createTestContext, freshMemos } from '../../../../support/context'
import { fakeGit, fakeSdk } from '../../../../support/fake-platform'
import { httpOk } from '../../../../fixtures/github-http'
import { hostingCtx } from '../../../../fixtures/hosting/store'
import type { CreateStageWorktreeResult, RemoveSessionWorktreeOutcome } from '@/types/workspace'
// The writer is the one stand-in here: `labelMapStore` moves the label maps this test drives the tick from, which the real writer would not.
const writer = vi.hoisted(() => ({ writeEvent: null as ((params: unknown) => Promise<unknown>) | null }))
vi.mock('@/main/pipeline/state/writer', () => ({ writeEvent: (_ctx: unknown, params: unknown) => writer.writeEvent?.(params) }))
const labelsRead = vi.hoisted(() => ({ of: null as ((kind: 'issue' | 'pull-request', number: number) => readonly string[]) | null }))
vi.mock('@/main/pipeline/state/labels', async (original) => ({ ...(await original<object>()), storedLabels: (_ctx: unknown, _repoId: unknown, kind: 'issue' | 'pull-request', number: number) => labelsRead.of?.(kind, number) ?? null }))
// Worktrees and their branches are the outer edge here, so they are faked at the worktree modules.
const worktrees = vi.hoisted(() => ({ create: null as (() => Promise<unknown>) | null, remove: null as ((path: string, force: boolean) => Promise<unknown>) | null }))
vi.mock('@/main/repos/worktree/stage-worktree', async (original) => ({
  ...(await original<object>()),
  createStageWorktree: () => worktrees.create?.(),
  releaseStageBranch: () => Promise.resolve('deleted'),
  sweepSessionBranches: () => Promise.resolve({ done: true, deleted: [] }),
}))
// The run scripts only plan and impl, so a review of the opened pull request is skipped the way a moved claim is.
vi.mock('@/main/pipeline/operator/stage', async (original) => {
  const actual = await original<typeof import('@/main/pipeline/operator/stage')>()
  return { ...actual, applyStageClaim: (ctx: Parameters<typeof actual.applyStageClaim>[0], params: Parameters<typeof actual.applyStageClaim>[1]) => (params.candidate.agent === 'review' ? Promise.resolve({ kind: 'refused', reason: 'moved', retryable: false, detail: null }) : actual.applyStageClaim(ctx, params)) }
})
vi.mock('@/main/repos/worktree/worktree', async (original) => ({ ...(await original<object>()), removeSessionWorktreeAt: (_ctx: unknown, params: { path: string; force: boolean }) => worktrees.remove?.(params.path, params.force) }))
vi.mock('@/main/dispatch/stage/instructions', async (original) => ({
  ...(await original<object>()),
  loadStageLaunch: (_ctx: unknown, _root: unknown, launchRequest: { agent: string; prompt: string }) => Promise.resolve({ ok: true, text: launchRequest.prompt, agent: { name: `${launchRequest.agent}-agent`, definition: { description: launchRequest.agent, prompt: 'body' }, selfContained: true } }),
}))

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
type PrMap = Map<number, { closes: number; branch: string; labels: Set<LabelKey> }>

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
    blockers: { ok: true, open: [], shown: 0, total: 0 },
    blockerComments: null,
    closingPullRequests: null,
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
    blockers: null,
    blockerComments: null,
    closingPullRequests: null,
  }))
  return [...issues, ...prItems]
}

function buildPipelineFetch(vocabulary: LabelVocabulary, labels: LabelMap, prs: PrMap): PipelineFetch {
  return {
    ok: true,
    items: pipelineItemsFor(vocabulary, labels, prs),
    closed: [], merged: [],
    queried: queriedLabelsFor(vocabulary),
    disabled: vocabulary.disabled,
    vocabulary: verifyVocabulary(vocabulary, { ok: true, names: vocabulary.labels.map((label) => label.name) }),
    unavailable: [],
    truncated: [],
    rateLimit: { cost: 1, remaining: 4999, resetAt: NOW_ISO, limit: 5000 },
    viewer: VIEWER,
    integrationChecks: {},
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

/** Branches on `options.agent`; each scripted session opens its pull request where the real agent would and ends with a `HANDBACK:` line, never touching a label. Any other agent, or a missing one, throws loudly. */
function createFakeSdk(seen: Options[], prs: PrMap): HostedSdk {
  return {
    query: ({ prompt, options }) => {
      if (options === undefined) throw new Error('scratch-run fake: query called with no options')
      if (options.agent !== 'plan-agent' && options.agent !== 'impl-agent') {
        throw new Error(`scratch-run fake: unexpected agent ${String(options.agent)}`)
      }
      if (typeof prompt === 'string') throw new Error('scratch-run fake: expected a streaming prompt, got a string')
      seen.push(options)
      const fake = fakeQuery()
      void (async () => {
        await prompt[Symbol.asyncIterator]().next() // the first user turn — store.send() really went through the handle
        if (options.agent === 'plan-agent') {
          fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-plan' })
          fake.push({ type: 'result', subtype: 'success', is_error: false, result: 'Plan written.\n\nHANDBACK: plan-written', total_cost_usd: 0.4 })
        } else {
          prs.set(8, { closes: 7, branch: '7-scratch-ticket', labels: new Set<LabelKey>() })
          fake.push({ type: 'system', subtype: 'init', session_id: 'sdk-impl' })
          fake.push({ type: 'result', subtype: 'success', is_error: false, result: 'PR opened.\n\nHANDBACK: pr-opened #8', total_cost_usd: 0.6 })
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

    async function createWorktree(): Promise<CreateStageWorktreeResult> {
      worktreeCounter += 1
      const path = `/scratch/session-${String(worktreeCounter)}`
      createdWorktrees.push(path)
      await ctx.fs.writeText(`${path}/.temp/plan-7.md`, '## Implementation Plan')
      return ({ ok: true, path, branch: `session-${String(worktreeCounter)}`, baseSha: 'base-sha', baseLabel: `session-${String(worktreeCounter)}`, reclaimed: null })
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
        const pr = prs.get(number)
        if (set !== undefined) {
          resolved.push({ number, kind: 'issue', state: 'OPEN', mergedAt: null, closedAt: null, title: `issue ${String(number)}`, url: `https://example.test/issues/${String(number)}`, labels: namesOf(VOCABULARY, set), assignees: [VIEWER], headRefName: null, author: null })
        } else if (pr !== undefined) {
          resolved.push({ number, kind: 'pull-request', state: 'OPEN', mergedAt: null, closedAt: null, title: `pr ${String(number)}`, url: `https://example.test/pull/${String(number)}`, labels: namesOf(VOCABULARY, pr.labels), assignees: [VIEWER], headRefName: pr.branch, author: VIEWER })
        } else {
          unavailable.push(number)
        }
      }
      return Promise.resolve({ ok: true, resolved, unavailable, fetchedAt: NOW_ISO })
    }

    const { ticketOf, writeEvent, labelWrites } = labelMapStore(labels, prs, entry.id, NOW_ISO)
    writer.writeEvent = (params) => writeEvent(params as WriteEventParams)
    labelsRead.of = (kind, number) => namesOf(VOCABULARY, (kind === 'issue' ? labels.get(number) : prs.get(number)?.labels) ?? new Set<LabelKey>())
    worktrees.create = createWorktree
    worktrees.remove = removeWorktree
    // Late-binding, the way the composition root assigns `live`: onStatus closes over the launcher, whose outcomes reach the dispatcher.
    const wired: { -readonly [K in keyof AppContext['live']]?: AppContext['live'][K] } = { memos: freshMemos(), watcher: { republish: vi.fn(), refresh: vi.fn(() => Promise.resolve()), snapshot: () => boardSnapshot() } as unknown as AppContext['live']['watcher'] }
    const ctx = createTestContext({
      live: wired,
      repositories: [entry],
      tickets: { repoId: REPO_ID, tickets: [stateTicketOf({ repo: REPO_ID, ticket: 7, stage: 'plan' })] },
      platform: {
        paths: { userData: '/test/userData', temp: await mkdtemp(join(tmpdir(), 'scratch-run-')), logs: '/test/logs' },
        git: () => Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' }),
        githubHttp: async (request) => {
          const query = (JSON.parse(request.body ?? '{}') as { query?: string }).query ?? ''
          const aliases = [...query.matchAll(/(\w+): issueOrPullRequest\(number: (\d+)\)/g)].map((match) => ({ alias: match[1] ?? '', number: Number(match[2]) }))
          const fetched = await fetchItemsByNumber({ numbers: aliases.map((entry) => entry.number) })
          const repository = Object.fromEntries(aliases.map(({ alias, number }) => {
            const found = fetched.resolved.find((resolved) => resolved.number === number)
            return [alias, found === undefined ? null : { __typename: found.kind === 'issue' ? 'Issue' : 'PullRequest', ...found, labels: { nodes: found.labels.map((name) => ({ name })) }, assignees: { nodes: found.assignees.map((login) => ({ login })) }, author: { login: found.author } }]
          }))
          return httpOk(JSON.stringify({ data: { repository } }))
        },
        ghWrite: (argv) => {
          if (argv[0] === 'issue' && argv[1] === 'edit' && argv.includes('--body-file')) labelWrites.push({ action: 'stage-handback-plan-body', number: Number(argv[2]) })
          return Promise.resolve({ ok: true, stdout: '', stderr: '' })
        },
      },
      stores: { pipelineState: { ticket: (repoId: RepoId, ref: { readonly kind: 'issue' | 'pull-request'; readonly number: number }) => ticketOf(repoId, ref.kind, ref.number) } as never },
    })

    const store = createHostedStore(hostingCtx({
      sdk: fakeSdk(createFakeSdk(seen, prs)),
      git: fakeGit((args) => {
        if (args[0] === 'rev-parse') return Promise.resolve({ ok: false, kind: 'nonzero', code: 128, stdout: '', stderr: 'not a repository' })
        removedWorktrees.push({ path: args[args.length - 1] ?? '', force: args.includes('--force') })
        return Promise.resolve({ ok: true, stdout: '', stderr: '' })
      }),
    }), {
      listSessions: () => Promise.resolve({ ok: true, sessions: [] }),
      persistence: createInMemoryHostingPersistence(),
      onStatus: (snapshot) => {
        listedSnapshots.push(snapshot)
        stageLauncher.observe(snapshot)
      },
    })

    await ctx.ready
    await ctx.fs.writeText('/repo/.agents/cockpit.json', JSON.stringify({ repo: 'o/scratch', owner: 'app', since: NOW_ISO }))
    await ctx.stores.runStates.set([REPO_ID], 'dispatching', NOW_ISO)

    wired.hostedStore = store
    const stageLauncher = createStageLauncher(ctx, '/bundle')
    wired.stageLauncher = stageLauncher
    const dispatcher = createDispatcher(ctx)
    wired.dispatcher = dispatcher
    const { unknownStreaks, refreshMemo } = ctx.live.memos

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
        runsOf: (repoId, kind, number) => ctx.stores.runs.runsOf(repoId, kind, number),
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
        autoPlan: [],
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
    await vi.waitFor(() => expect(labels.get(7)?.has('planReview')).toBe(true))

    // The human gate hasn't been applied yet, so nothing new launches.
    await tick()
    expect(seen).toHaveLength(1)

    moveLabel(labels, 7, 'planReview', 'planApproved')
    await tick()
    await waitForEndedCompleted(2)
    await vi.waitFor(() => expect(labels.get(7)?.has('prOpened')).toBe(true))

    // No actionable item remains after the impl stage settles.
    const beforeFinal = seen.length
    await tick()
    expect(seen).toHaveLength(beforeFinal)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ agent: 'plan-agent', model: 'opus', permissionMode: 'default' })
    expect(seen[1]).toMatchObject({ agent: 'impl-agent', model: 'sonnet', permissionMode: 'default' })

    expect(listedSnapshots.every((s) => s.stage !== null)).toBe(true)

    expect([...(labels.get(7) ?? [])]).toContain('prOpened')
    expect([...(labels.get(7) ?? [])]).not.toContain('inProgress')
    expect([...(prs.get(8)?.labels ?? [])]).toEqual(expect.arrayContaining(['readyForReview', 'marker']))
    expect(labelWrites).toEqual([
      { action: 'stage-claim', number: 7 },
      { action: 'stage-handback-plan-body', number: 7 },
      { action: 'stage-handback-plan-written', number: 7 },
      { action: 'stage-claim', number: 7 },
      { action: 'stage-handback-pr-opened', number: 7 },
      { action: 'stage-handback-pr-opened', number: 8 },
    ])

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
