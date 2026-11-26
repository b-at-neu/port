// One app run for a scenario: real dispatcher, real pipeline writers, a fake GitHub and a scripted hosted store. A restart is a second call over the same disk.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { AppContext } from '@/main/app/context'
import { createDispatcher } from '@/main/dispatch/dispatcher'
import { pathOps } from '@/main/platform/paths'
import { createRefreshMemo, createUnknownStreaks } from '@/main/pipeline/tick/ledger'
import { planTick } from '@/main/pipeline/tick/plan'
import type { BoardSnapshot } from '@/types/board'
import type { PlatformFs } from '@/types/platform'
import type { SessionKey } from '@/types/hosting'
import type { StagePlanFile } from '@/types/stage-labels'
import type { StageOutcome } from '@/types/stage-session'
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
// The audit log and the body files go through the host filesystem, so this directory is real; everything else lives in the fake one.
const SCRATCH = mkdtempSync(join(tmpdir(), 'port-scenario-'))
const STATE_FILE = `${SCRATCH}/pipeline-state.json`
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

type Actionable = TickReport['actionable'][number]

export const actionable = (number: number, trigger: Actionable['trigger'], agent: Actionable['agent'], kind: Actionable['kind'] = 'issue'): Actionable => ({ number, kind, trigger, agent, unchecked: false, cycle: null })

export const tickReport = (overrides: Partial<TickReport> = {}): TickReport => ({ repoId: SCENARIO_REPO, displayName: 'o/a', blind: null, actionable: [], held: [], claims: [], disabledStages: [], nextTickAt: null, observations: [], autoApprovals: [], labelRepairs: [], ...overrides })

export const snapshotWith = (...tick: TickReport[]): BoardSnapshot => boardSnapshot([repositoryState([])], undefined, { tick })

export async function scenarioRig(options: ScenarioOptions = {}) {
  const fs = options.fs ?? createFakeFs()
  const github = createFakeGitHub({ viewer: 'viewer', items: options.items ?? [] })
  let board = boardSnapshot()
  const watcher = { republish: vi.fn(), refresh: vi.fn(() => Promise.resolve({} as BoardSnapshot)), snapshot: () => board }
  const live: { -readonly [K in keyof AppContext['live']]?: AppContext['live'][K] } = { memos: freshMemos(), watcher: watcher as unknown as AppContext['live']['watcher'] }
  const entry = readyEntry()
  const ctx = createTestContext({ platform: { ...github.platform, fs, paths: { userData: SCRATCH, temp: SCRATCH, logs: SCRATCH } }, repositories: [entry], live })
  await ctx.ready
  await ctx.fs.writeText(pathOps.join(entry.path, '.agents', 'cockpit.json'), JSON.stringify({ repo: entry.config.repo, owner: 'app', since: AT }))
  await ctx.stores.runStates.set([SCENARIO_REPO], 'dispatching', ctx.clock.now().toISOString())
  const stage = scriptedStage(ctx.stores.runs, SCENARIO_REPO, ctx.clock.now)
  live.hostedStore = stage.store
  live.stageLauncher = stage.launcher as unknown as AppContext['live']['stageLauncher']
  const dispatcher = createDispatcher(ctx)
  live.dispatcher = dispatcher

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
    /** The session ends with a hand-back: the run records its outcome and the dispatcher settles the stage. */
    finish: async (key: SessionKey, outcome: StageOutcome, plan: StagePlanFile | null = null) => {
      await stage.handBack(key, outcome)
      dispatcher.recordOutcome(SCENARIO_REPO, key, outcome, plan)
    },
    tickOver,
    /** What the watcher's snapshot reads from now on: the board the operator's controls act on. */
    showBoard: (...items: readonly ReconciledItem[]) => {
      board = boardSnapshot([repositoryState(items)])
    },
    claimedItem: (number: number) => reconciledItem({ number, kind: 'issue', stage: 'in-flight', stages: [{ key: 'inProgress', name: 'in progress', role: 'in-flight' }], stageHistory: [{ key: 'inProgress', actor: null, at: AT }] }),
  }
}
