import { createDispatcher } from '@/main/dispatch/dispatcher'
import { stageModeFor } from '@/main/pipeline/transitions'
import type { CreateDispatcherParams, Dispatcher, StageLauncher, StageLaunchRequest, StageLaunchResult } from '@/types/dispatch'
import type { RunStore } from '@/types/stage'
import { stageOfMode } from '@/types/stage-labels'
import type { RepoId } from '@/utils/repos'
import { memoryRuns } from './state-store'
import { runOf, ticketOf } from './tickets'

/** A run store over one ticket with only an issue, and one with an issue and its pull request — the two shapes the dispatcher tests launch against. */
export function dispatchRuns(repoId: RepoId) {
  return memoryRuns(repoId, {
    at: '2026-01-01T00:00:00.000Z',
    tickets: [ticketOf({ repo: repoId, ticket: 52, stage: 'implement' }), ticketOf({ repo: repoId, ticket: 46, pr: { number: 47, approvedAt: null }, stage: 'review' })],
  })
}

/** The dispatcher over a launcher that records the run a real one would. */
export function buildDispatcher(repoId: RepoId, deps: CreateDispatcherParams): Dispatcher {
  const { launch } = deps
  return createDispatcher({ ...deps, launch: launch === null ? null : recordingLauncher(deps.runs, repoId, (request) => launch.launch(request)) })
}

/** A launcher that records the run a real one would, so the dispatcher reads its record back from the store. */
export function recordingLauncher(runs: RunStore, repoId: RepoId, launch: (request: StageLaunchRequest) => Promise<StageLaunchResult>): StageLauncher {
  return {
    launch: async (request) => {
      const result = await launch(request)
      if (result.ok) {
        await runs.start(
          repoId,
          runOf({ id: `run-of-${result.sessionKey}`, stage: stageOfMode(stageModeFor(request.agent, request.trigger)), item: { kind: request.kind, number: request.number }, agent: request.agent, trigger: request.trigger, model: request.model, title: request.title, sessionKey: result.sessionKey, startedAt: '2026-01-01T00:00:00.000Z' }),
        )
      }
      return result
    },
  }
}
