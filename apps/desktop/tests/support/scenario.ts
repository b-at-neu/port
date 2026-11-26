// One app run for a scenario: real dispatcher, real pipeline writers, a fake GitHub and a scripted hosted store. A restart is a second call over the same disk.
import { vi } from 'vitest'
import type { AppContext } from '@/main/app/context'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { pathOps } from '@/main/platform/paths'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import type { BoardSnapshot } from '@/types/board'
import type { PlatformFs } from '@/types/platform'
import type { StageTrigger } from '@/types/stage-labels'
import type { ReconciledItem } from '@/types/state'
import type { TickReport } from '@/types/tick'
import type { Ticket } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'
import { boardSnapshot, reconciledItem, repositoryState } from './board-snapshot'
import { createTestContext, freshMemos } from './context'
import { createFakeFs } from './fake-platform'
import { createFakeGitHub, type FakeItem } from './fake-github'
import { readyEntry } from './repo-config'
import { scriptedStage } from './stage'

export const SCENARIO_REPO = 'repo-a' as RepoId
const STATE_FILE = '/test/userData/pipeline-state.json'
const AT = '2026-01-01T00:00:00.000Z'

export interface ScenarioOptions {
  readonly fs?: PlatformFs
  readonly items?: readonly FakeItem[]
}

/** The disk an earlier app run left behind: these tickets seeded in the pipeline state file. */
export async function diskWith(...tickets: readonly Ticket[]): Promise<PlatformFs> {
  const fs = createFakeFs()
  await fs.writeJsonAtomic(STATE_FILE, { version: 3, dispatch: {}, repositories: { [SCENARIO_REPO]: { seededAt: AT, tickets: Object.fromEntries(tickets.map((ticket) => [String(ticket.ticket), ticket])) } } })
  return fs
}

export const actionable = (number: number, trigger: StageTrigger, agent: TickReport['actionable'][number]['agent']): TickReport['actionable'][number] => ({ number, kind: 'issue', trigger, agent, unchecked: false, cycle: null })

export const tickReport = (overrides: Partial<TickReport> = {}): TickReport => ({ repoId: SCENARIO_REPO, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides })

export const snapshotWith = (...tick: TickReport[]): BoardSnapshot => boardSnapshot([repositoryState([])], undefined, { tick })

export async function scenarioRig(options: ScenarioOptions = {}) {
  const fs = options.fs ?? createFakeFs()
  const github = createFakeGitHub({ viewer: 'viewer', items: options.items ?? [] })
  const watcher = { republish: vi.fn(), refresh: vi.fn(() => Promise.resolve({} as BoardSnapshot)), snapshot: () => boardSnapshot() }
  const live: { -readonly [K in keyof AppContext['live']]?: AppContext['live'][K] } = { memos: freshMemos(), watcher: watcher as unknown as AppContext['live']['watcher'] }
  const entry = readyEntry()
  const ctx = createTestContext({ platform: { ...github.platform, fs }, repositories: [entry], live })
  await ctx.ready
  await ctx.fs.writeText(pathOps.join(entry.path, '.agents', 'cockpit.json'), JSON.stringify({ repo: entry.config.repo, owner: 'app', since: AT }))
  await ctx.stores.runStates.set([SCENARIO_REPO], 'dispatching', ctx.clock.now().toISOString())
  const stage = scriptedStage(ctx.stores.runs, SCENARIO_REPO, ctx.clock.now)
  live.hostedStore = stage.store
  live.stageLauncher = stage.launcher as unknown as AppContext['live']['stageLauncher']
  const dispatcher = createDispatcher(ctx)

  /** What the tick makes of the claimed item, given the dispatcher's liveness and the runs on disk. */
  const tickOver = (item: ReconciledItem, readAt: string): TickReport =>
    planTick({
      repository: repositoryState([item], {}, readAt),
      runsOf: (repoId, kind, number) => ctx.stores.runs.runsOf(repoId, kind, number),
      stageLiveness: dispatcher.stageLiveness(SCENARIO_REPO),
      unknownStreaks: createUnknownStreaks(),
      nextDecisionAt: new Date(readAt),
      now: () => new Date(readAt),
      reviewCycleCap: 5,
      startedTasks: [],
      refreshMemo: createRefreshMemo(),
      checkDispositions: {},
      holdSessionRequired: false,
    })

  return {
    ctx,
    github,
    stage,
    dispatcher,
    runs: ctx.stores.runs,
    ticket: (number: number) => ctx.stores.pipelineState.ticket(SCENARIO_REPO, { kind: 'issue', number }),
    consider: (...tick: TickReport[]) => dispatcher.consider(snapshotWith(...tick)),
    tickOver,
    claimedItem: (number: number) => reconciledItem({ number, kind: 'issue', stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], stageHistory: [{ key: 'inProgress', actor: null, at: AT }] }),
  }
}
