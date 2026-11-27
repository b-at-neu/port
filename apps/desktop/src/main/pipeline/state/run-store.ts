// The one door every run write and run read goes through: each write is one `RunChange` on the pipeline state, each read a projection of `Ticket.runs`.
import { denialsOf, dispatchRecordOf, interruptedRuns, openRuns, outcomeOf } from '@/main/pipeline/runs'
import type { StageRecord } from '@/types/dispatch'
import type { PipelineStateStore } from '@/types/pipeline-state'
import type { RunStore, UnsettledStage } from '@/types/stage'
import type { RunChange } from '@/types/stage-labels'
import type { Run } from '@/utils/pipeline/ticket'
import type { RepoId } from '@/utils/repos'

interface CreateRunStoreParams {
  readonly store: PipelineStateStore
  readonly newId: () => string
  readonly now: () => Date
}

export function createRunStore({ store, newId, now }: CreateRunStoreParams): RunStore {
  // A run write that fails is logged and never blocks the session: a session with no recorded run reads `no-record` and is never reset.
  async function log(label: string, written: ReturnType<PipelineStateStore['applyRun']>): Promise<void> {
    const result = await written
    if (!result.ok) console.error(`[stage] could not record ${label}: ${result.reason}${'message' in result ? ` (${result.message})` : ''}`)
  }

  const change = (repoId: RepoId, runId: string, next: RunChange): Promise<void> => log(`${next.kind} on run ${runId}`, store.applyRun(repoId, runId, next))

  function repoRuns(repoId: RepoId): readonly { readonly ticket: NonNullable<ReturnType<PipelineStateStore['tickets']>>[number]; readonly run: Run }[] {
    return (store.tickets(repoId) ?? []).flatMap((ticket) => ticket.runs.map((run) => ({ ticket, run })))
  }

  async function clearRule(repoId: RepoId, rule: string): Promise<void> {
    for (const { run } of repoRuns(repoId).filter(({ run: candidate }) => candidate.denials.some((denial) => denial.rule === rule))) await change(repoId, run.id, { kind: 'denials-cleared', rule })
  }

  return {
    start: (repoId, run) => log(`run ${run.id}`, store.startRun(repoId, run)),
    launchFailed: (repoId, failure) => {
      const at = now().toISOString()
      const run: Run = {
        id: newId(),
        stage: failure.stage,
        item: { kind: failure.kind, number: failure.number },
        agent: failure.agent,
        model: failure.model,
        title: failure.title,
        sessionKey: null,
        claudeSessionId: null,
        worktree: null,
        startedAt: at,
        endedAt: at,
        outcome: null,
        handback: null,
        costUsd: null,
        operatorJoinedAt: null,
        failure: failure.message,
        interruption: null,
        networkRetries: 0,
        denials: [],
      }
      return log(`failed launch of #${String(failure.number)}`, store.startRun(repoId, run))
    },
    resumed: (repoId, runId, sessionKey) => change(repoId, runId, { kind: 'resumed', sessionKey }),
    session: (repoId, runId, claudeSessionId) => change(repoId, runId, { kind: 'session', claudeSessionId }),
    joined: (repoId, runId, at) => change(repoId, runId, { kind: 'joined', at }),
    handback: (repoId, runId, outcome) => change(repoId, runId, { kind: 'handback', outcome }),
    ended: (repoId, runId, outcome) => change(repoId, runId, { kind: 'ended', outcome }),
    interrupt: (repoId, runId, interruption) => change(repoId, runId, { kind: 'interrupted', ...interruption }),
    cleared: (repoId, runId) => change(repoId, runId, { kind: 'cleared' }),
    denied: (repoId, runId, denial) => change(repoId, runId, { kind: 'denied', denial }),
    async dismissDenial(repoId, id) {
      const rule = repoRuns(repoId)
        .flatMap(({ run }) => run.denials)
        .find((denial) => denial.id === id)?.rule
      if (rule !== undefined) await clearRule(repoId, rule)
    },
    clearRule,
    quitAll: () => store.quitRuns(),
    list: (repoId) => interruptedRuns(store.allTickets()).filter((entry) => repoId === undefined || entry.repoId === repoId),
    running: () => openRuns(store.allTickets()),
    denials: (repoId) => denialsOf(store.tickets(repoId) ?? []),
    records: (repoId): readonly StageRecord[] => repoRuns(repoId).map(({ run }) => dispatchRecordOf(run)).sort((a, b) => a.at.localeCompare(b.at)),
    runsOf: (repoId, kind, number) => store.ticket(repoId, { kind, number })?.runs ?? [],
    unsettled: (repoId): readonly UnsettledStage[] =>
      store.takeReplays(repoId).flatMap(({ run }) => {
        const outcome = outcomeOf(run)
        return run.sessionKey === null || outcome === null ? [] : [{ record: { ...dispatchRecordOf(run), sessionKey: run.sessionKey }, outcome }]
      }),
  }
}
