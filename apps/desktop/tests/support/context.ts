// An in-memory AppContext, and the call that runs an action exactly as the router does.
import type { AppContext } from '@/main/app/context'
import type { PipelineMemos } from '@/main/pipeline/context'
import { actions } from '@/main/app/router'
import { createRunStateStore } from '@/main/pipeline/state/run-state'
import { createRunStore } from '@/main/pipeline/state/run-store'
import { createIncidentLog } from '@/main/pipeline/incidents/log'
import { createPipelineStateStore, PIPELINE_STATE_FILE } from '@/main/pipeline/state/store'
import { createForceDispatch, createRefreshMemo, createRerunMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { createRecentsStore } from '@/main/features/folders/recents'
import { createSessionIndex } from '@/main/sessions/hosting/session-index'
import { createUsageLedger } from '@/main/sessions/hosting/usage-ledger'
import { vi, type Mock } from 'vitest'
import { stageModeFor } from '@/main/pipeline/transitions'
import type { Platform } from '@/main/platform'
import { pathOps } from '@/main/platform/paths'
import { isReadyEntry, readyOf, type Repos } from '@/main/repos'
import type { BoardSnapshot } from '@/types/board'
import type { RunState, StageLaunchRequest, StageLaunchResult } from '@/types/dispatch'
import type { HostedStore } from '@/types/hosting'
import { stageOfMode } from '@/types/stage-labels'
import { DISPATCH_STORE_DEFAULTS, storeStub } from '../fixtures/store'
import { boardSnapshot } from './board-snapshot'
import { createFakeGitHub, type FakeGitHub, type FakeItem } from './fake-github'
import { readyEntry } from './repo-config'
import { runOf } from './tickets'
import type { EventMap, EventName } from '@/main/app/events'
import type { StateEngine } from '@/types/offload'
import type { ActionInput, ActionName, ActionOutput } from '@/types/ipc'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId, RepositoryEntry } from '@/utils/repos'
import { createFakePlatform, type FakePlatform } from './fake-platform'

const SEEDED_AT = '2026-11-23T12:00:00.000Z'

export interface TestContextOptions {
  readonly platform?: Partial<Platform>
  readonly repositories?: readonly RepositoryEntry[]
  /** Seeds the pipeline state file with these tickets for one repository, so it reads as seeded. */
  readonly tickets?: { readonly repoId: RepoId; readonly tickets: readonly Ticket[] }
  readonly repos?: Partial<Repos>
  readonly stores?: Partial<AppContext['stores']>
  readonly live?: Partial<AppContext['live']>
  readonly seams?: Partial<AppContext['seams']>
}

export type TestContext = AppContext & {
  /** Settles once the pipeline state file has been read and its boot recovery written. */
  readonly ready: Promise<void>
  readonly clock: FakePlatform['clock']
  readonly emitted: { readonly event: EventName; readonly payload: unknown }[]
}

/** A member the test did not pass throws on read, so no action silently runs against a stand-in. */
function unscriptedGroup<T extends object>(group: string, given: Partial<T>): T {
  return new Proxy(given, {
    get(target, key, receiver) {
      if (key in target) return Reflect.get(target, key, receiver) as unknown
      if (typeof key === 'symbol' || key === 'then') return undefined
      throw new Error(`ctx.${group}.${key} is not in this test context; pass it to createTestContext`)
    },
  }) as T
}

/** An engine whose unscripted members throw. */
export function fakeEngine(given: Partial<StateEngine>): StateEngine {
  return unscriptedGroup('live.engine', given)
}

function memoryRepos(seed: readonly RepositoryEntry[], platform: Platform): Omit<Repos, 'deps'> {
  let entries = [...seed]
  const repos = {
    list: () => Promise.resolve({ ok: true as const, repositories: entries }),
    resolve: (repoId) => Promise.resolve(readyOf({ ok: true, repositories: entries }, repoId)),
    remove: (id) => {
      const remaining = entries.filter((entry) => entry.id !== id)
      if (remaining.length === entries.length) return Promise.resolve({ ok: false as const, kind: 'not-registered' as const, message: `no repository is registered with id '${id}'` })
      entries = remaining
      return Promise.resolve({ ok: true as const, repositories: entries })
    },
    add: async () => {
      const picked = await platform.dialogs.chooseDirectory()
      if (picked === null) return { ok: true as const, outcome: 'cancelled' as const }
      throw new Error('repos.add picked a directory; pass repos.add to createTestContext')
    },
  } satisfies Omit<Repos, 'deps'>
  return repos
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const fake = createFakePlatform()
  const platform: FakePlatform = { ...fake, ...options.platform, clock: (options.platform?.clock as FakePlatform['clock'] | undefined) ?? fake.clock }
  const emitted: TestContext['emitted'] = []

  const repos = { ...memoryRepos(options.repositories ?? [], platform), ...options.repos } as Repos
  if (options.repos?.deps === undefined) {
    Object.defineProperty(repos, 'deps', {
      enumerable: true,
      get: () => {
        throw new Error('ctx.repos.deps reads the real registry file; pass repos to createTestContext')
      },
    })
  }

  const path = (file: string): string => `${platform.paths.userData}/${file}`
  if (options.tickets !== undefined) {
    const { repoId, tickets } = options.tickets
    void platform.fs.writeJsonAtomic(path(PIPELINE_STATE_FILE), { version: 3, dispatch: {}, repositories: { [repoId]: { seededAt: SEEDED_AT, tickets: Object.fromEntries(tickets.map((ticket) => [String(ticket.ticket), ticket])) } } })
  }
  const state = createPipelineStateStore(platform)
  const stores = {
    runs: createRunStore({ store: state, newId: () => globalThis.crypto.randomUUID(), now: platform.clock.now }),
    runStates: createRunStateStore(state, path(PIPELINE_STATE_FILE)),
    pipelineState: state,
    incidentLog: createIncidentLog(platform),
    sessionIndex: createSessionIndex({ path: path('session-index.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now }),
    usageLedger: createUsageLedger({ path: path('usage-ledger.json'), readJson: platform.fs.readJson, writeJsonAtomic: platform.fs.writeJsonAtomic, now: platform.clock.now, bootId: 'test-boot' }),
    recents: createRecentsStore(platform, { dir: platform.paths.userData }),
    ...options.stores,
  }

  return {
    ...platform,
    emit: <E extends EventName>(event: E, payload: EventMap[E]) => {
      emitted.push({ event, payload })
    },
    emitted,
    ready: state.ready,
    repos,
    stores: unscriptedGroup('stores', stores),
    live: unscriptedGroup('live', options.live ?? {}),
    seams: unscriptedGroup('seams', options.seams ?? {}),
  }
}

type IdleDispatcher = Pick<AppContext['live']['dispatcher'], 'status' | 'liveStages' | 'holdsSessionRequired' | 'stageLiveness' | 'endedStages'>

const IDLE_DISPATCHER: IdleDispatcher = {
  status: () => [],
  liveStages: () => [],
  holdsSessionRequired: () => true,
  stageLiveness: () => null,
  endedStages: () => [],
}

const EMPTY_PROJECTION = { repositories: [], sessions: { ok: true, sessions: [], agents: [], unattributed: 0, unresolved: [], unreadable: [], scannedProjects: 0, scanMs: 0, scannedAt: '2026-01-01T00:00:00.000Z' }, readAt: '2026-01-01T00:00:00.000Z' } as const

const OK_REFRESH = { ok: true, at: '2026-01-01T00:00:00.000Z' } as const

/** A scripted engine: every refresh succeeds and the board projects empty, each member replaceable. */
export function scriptedEngine(overrides: Partial<StateEngine> = {}): StateEngine {
  const unscripted = (name: string) => () => Promise.reject(new Error(`engine.${name} is not scripted`))
  return {
    refreshSessions: () => Promise.resolve(OK_REFRESH),
    refreshWorktrees: () => Promise.resolve(OK_REFRESH),
    refreshDenials: () => Promise.resolve(OK_REFRESH),
    refreshGithub: () => Promise.resolve(OK_REFRESH),
    precheckGithub: () => Promise.resolve({ ok: true, changed: false, at: OK_REFRESH.at }),
    project: () => Promise.resolve(EMPTY_PROJECTION),
    scanSessions: unscripted('scanSessions'),
    listSessions: unscripted('listSessions'),
    search: unscripted('search'),
    tailOpen: unscripted('tailOpen'),
    tailPoll: unscripted('tailPoll'),
    tailClose: unscripted('tailClose'),
    forgetRepo: unscripted('forgetRepo'),
    ...overrides,
  }
}

export interface WatcherContextOptions extends TestContextOptions {
  readonly engine?: Partial<StateEngine>
  readonly dispatcher?: Partial<IdleDispatcher>
}

export function freshMemos(): PipelineMemos {
  return { unknownStreaks: createUnknownStreaks(), refreshMemo: createRefreshMemo(), rerunMemo: createRerunMemo(), forceDispatch: createForceDispatch() }
}

/** A test context whose `live` holds what the watcher reads: a scripted engine, an idle dispatcher, fresh memos. */
export function watcherContext(options: WatcherContextOptions = {}): TestContext {
  const { engine, dispatcher, ...rest } = options
  return createTestContext({
    ...rest,
    live: {
      engine: scriptedEngine(engine),
      dispatcher: { ...IDLE_DISPATCHER, ...dispatcher } as unknown as AppContext['live']['dispatcher'],
      autoPlanner: { refused: () => new Set<number>() } as unknown as AppContext['live']['autoPlanner'],
      memos: freshMemos(),
      ...rest.live,
    },
  })
}

export interface DispatchContextOptions {
  readonly owner?: 'none' | 'app' | 'unreadable'
  readonly runState?: RunState
  /** What the fake GitHub holds, for every read and write the dispatch passes make. */
  readonly items?: readonly FakeItem[]
  readonly tickets?: TestContextOptions['tickets']
  readonly repositories?: readonly RepositoryEntry[]
  /** A launch that succeeds is recorded as the run a real launcher would start. */
  readonly launcher?: (request: StageLaunchRequest) => Promise<StageLaunchResult>
  readonly store?: Partial<HostedStore>
  readonly live?: Partial<AppContext['live']>
}

export type DispatchTestContext = TestContext & {
  readonly github: FakeGitHub
  readonly watcher: { readonly republish: Mock; readonly refresh: Mock }
  /** Assigns what `live` holds once a service exists, the way the composition root does. */
  readonly wire: Partial<Record<keyof AppContext['live'], unknown>>
}

/** A test context for the dispatch passes: fake GitHub, the repository's owner on disk, a run state, and a scripted store and launcher. */
export async function dispatchContext(options: DispatchContextOptions = {}): Promise<DispatchTestContext> {
  const repositories = options.repositories ?? [readyEntry()]
  const entry = repositories[0]
  const github = createFakeGitHub({ viewer: 'viewer', items: options.items ?? [] })
  const watcher = { republish: vi.fn(), refresh: vi.fn(() => Promise.resolve({} as BoardSnapshot)), snapshot: () => boardSnapshot() }
  const live: Partial<AppContext['live']> = {
    hostedStore: storeStub({ ...DISPATCH_STORE_DEFAULTS, ...options.store }),
    watcher: watcher as unknown as AppContext['live']['watcher'],
    memos: freshMemos(),
    ...options.live,
  }
  const ctx = createTestContext({ platform: github.platform, repositories, tickets: options.tickets, live })
  if (live.stageLauncher === undefined && options.launcher !== undefined) {
    const launch = options.launcher
    const repoId = entry?.id ?? ('repo-a' as RepoId)
    ;(live as { stageLauncher: unknown }).stageLauncher = {
      launch: async (request: StageLaunchRequest) => {
        const result = await launch(request)
        if (result.ok) await ctx.stores.runs.start(repoId, runOf({ id: `run-of-${result.sessionKey}`, stage: stageOfMode(stageModeFor(request.agent, request.trigger)), item: { kind: request.kind, number: request.number }, agent: request.agent, trigger: request.trigger, model: request.model, title: request.title, sessionKey: result.sessionKey, startedAt: ctx.clock.now().toISOString() }))
        return result
      },
    }
  }
  await ctx.ready
  if (entry !== undefined && isReadyEntry(entry)) {
    const owner = options.owner ?? 'none'
    if (owner !== 'none') await ctx.fs.writeText(pathOps.join(entry.path, '.agents', 'cockpit.json'), JSON.stringify({ repo: entry.config.repo, owner: owner === 'app' ? 'app' : 'terminal', since: '2026-01-01T00:00:00.000Z' }))
    await ctx.stores.runStates.set([entry.id], options.runState ?? 'dispatching', ctx.clock.now().toISOString())
  }
  return Object.assign(ctx, { github, watcher, wire: live as DispatchTestContext['wire'] })
}

/** Runs an action exactly as the router does: parse the raw request, then `run`. */
export async function callAction<N extends ActionName>(ctx: AppContext, name: N, input?: ActionInput<N>): Promise<ActionOutput<N>> {
  const action = actions.find((candidate) => candidate.name === name)
  if (action === undefined) throw new Error(`no action named '${name}'`)
  const run = action.run as (ctx: AppContext, input: unknown) => unknown
  return (await run(ctx, action.input.parse(input))) as ActionOutput<N>
}
