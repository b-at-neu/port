import type { ReadyEntry } from '@/types/actions'
import type { BudgetNote, CreateDispatcherParams, DispatchOwner, RunState, StageLaunchFailureCause, StageRecord } from '@/types/dispatch'
import { stageOfMode } from '@/types/stage-labels'
import { stageModeFor } from '@/main/pipeline/transitions'
import { RUN_TARGET } from '@/types/dispatch'
import type { PipelineItemKind, ResolvedItem } from '@/types/github'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { ReconciledItem } from '@/types/state'
import type { TickActionable } from '@/types/tick'
import type { StageWorktreeTarget } from '@/types/workspace'
import type { RepoId } from '@/utils/repos'
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import { reviewDispatchFacts } from '@/utils/pipeline/gates'
import type { ReviewDispatchFacts } from '@/utils/pipeline/gates'
import { KIND_PROMPT_NAMES, STAGE_PROMPT_NAMES } from '@/utils/stage/prompt'
import { ticketIndex, ticketLabelFor } from '@/utils/tickets/ticket'
import { budgetRoute, escalateOverBudget } from '@/main/dispatch/budget'
import { activeOrIdle } from '@/main/dispatch/records'
import type { RepoDispatcherState } from '@/main/dispatch/records'
import { launchFailedIntent } from '@/main/pipeline/incidents/raise'
import type { createRaiser } from '@/main/pipeline/incidents/raise'

const NOTE_LIMIT = 20

/** The text the stage session's first message opens with; port has already moved the label, so no agent step names one. */
export const DISPATCH_PROMPT = '<Stage> stage for <kind> #<n>. Run your pipeline stage for #<n>. port has already moved its label. Follow your Pre-flight, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Refresh stage for pull request #<n>. Run your pipeline stage for pull request #<n> in refresh mode.'

/** A `StageLaunchRequest.prompt` is filled from this, never re-derived at the launcher. */
export function promptFor(actionable: Pick<TickActionable, 'trigger' | 'number' | 'agent' | 'kind'>): string {
  const n = String(actionable.number)
  if (actionable.trigger === 'refreshBranch') return REFRESH_PROMPT.replaceAll('<n>', n)
  return DISPATCH_PROMPT.replaceAll('<Stage>', STAGE_PROMPT_NAMES[actionable.agent]).replaceAll('<kind>', KIND_PROMPT_NAMES[actionable.kind]).replaceAll('<n>', n)
}

/** The re-read survivor test: the trigger's resolved name is still present and the viewer is still an assignee. `stateLabels` are the store's names; `null` is an unseeded repository, which launches nothing this tick. */
export function survived(resolved: ResolvedItem, candidate: TickActionable, vocabulary: LabelVocabulary, viewer: string, stateLabels: readonly string[] | null): boolean {
  if (stateLabels === null) return false
  const triggerLabel = vocabulary.labels.find((l) => l.key === candidate.trigger)
  if (triggerLabel === undefined || !stateLabels.includes(triggerLabel.name)) return false
  return resolved.assignees.includes(viewer)
}

/** Hosted snapshots whose `phase !== 'ended'` — operator and stage sessions alike; stage sessions share the hosted cap. */
export function liveCount(snapshots: readonly HostedSessionSnapshot[]): number {
  return snapshots.filter((s) => s.phase !== 'ended').length
}

export function freeSlots(limit: number, snapshots: readonly HostedSessionSnapshot[]): number {
  return Math.max(0, limit - liveCount(snapshots))
}

export function targetOf(kind: PipelineItemKind, resolved: ResolvedItem | undefined): StageWorktreeTarget {
  if (kind === 'pull-request') return { kind: 'pr', headRefName: resolved?.headRefName ?? null }
  return { kind: 'issue', title: resolved?.title ?? '' }
}

/** What the dispatcher lends the launch section: its own state, never a second copy of it. */
interface LaunchEnv {
  readonly deps: CreateDispatcherParams
  readonly raise: ReturnType<typeof createRaiser>
  readonly isStopped: () => boolean
  /** Runs `fn` after every earlier launch section, so two repositories never race for the same free slot. */
  readonly serialize: <T>(fn: () => Promise<T>) => Promise<T>
  readonly recordsOf: (repoId: RepoId) => readonly StageRecord[]
  readonly report: (repoId: RepoId, owner: DispatchOwner, state: RepoDispatcherState['dispatcherState'], runState: RunState) => void
  readonly itemsOf: (repoId: RepoId) => readonly ReconciledItem[]
}

interface LaunchPass {
  readonly entry: ReadyEntry
  readonly survivors: readonly TickActionable[]
  readonly resolvedByNumber: ReadonlyMap<number, ResolvedItem>
  readonly state: RepoDispatcherState
  readonly owner: DispatchOwner
  readonly runState: RunState
  readonly viewer: string
}

export function createLaunchSection(env: LaunchEnv): { readonly launchSurvivors: (pass: LaunchPass) => Promise<void> } {
  const { deps, raise, report } = env

  /** A launch that never produced a session still shows as a run, ended the instant it started. */
  async function recordFailure(entry: ReadyEntry, candidate: TickActionable, message: string): Promise<void> {
    await deps.runs.launchFailed(entry.id, { stage: stageOfMode(stageModeFor(candidate.agent, candidate.trigger)), kind: candidate.kind, number: candidate.number, agent: candidate.agent, trigger: candidate.trigger, model: entry.config.models[candidate.agent], title: null, message })
  }

  /** Trigger → in-flight before the session exists. `moved` skips silently, since the next read shows the truth; any other refusal is a launch failure. */
  async function claim(entry: ReadyEntry, candidate: TickActionable, resolved: ResolvedItem | undefined): Promise<boolean> {
    if (resolved === undefined) return false
    const result = await deps.stageLabels.claim({ entry, candidate, resolved, auditDir: deps.dirs.audit })
    if (result.kind === 'applied') return true
    if (result.reason !== 'moved') await launchFailed(entry, candidate, `claim-${result.reason}`, `port couldn't move the label before starting: ${result.reason}${result.detail === null ? '' : ` (${result.detail})`}`, false)
    return false
  }

  /** A launch that never produced a session: undoes the claim when it made one, records the failure and raises its incident. */
  async function launchFailed(entry: ReadyEntry, candidate: TickActionable, cause: StageLaunchFailureCause | `claim-${string}`, message: string, undo: boolean): Promise<void> {
    if (undo) await rollback(entry, candidate)
    await recordFailure(entry, candidate, message)
    raise(entry.id, candidate, launchFailedIntent(candidate, cause), { kind: 'failed' })
  }

  /** Undoes a claim whose launch failed; a refused rollback is left to the stall ladder. */
  async function rollback(entry: ReadyEntry, candidate: TickActionable): Promise<void> {
    await deps.stageLabels.transition({ entry, record: candidate, event: { kind: 'rollback' }, auditDir: deps.dirs.audit, scratchDir: deps.dirs.scratch })
  }

  /** The budget gate per candidate: dispatched, held for one pass, or escalated to a human. */
  async function budgetGated(pass: LaunchPass): Promise<readonly TickActionable[]> {
    const { entry, survivors, state, viewer } = pass
    const notes: BudgetNote[] = []
    const kept: TickActionable[] = []
    for (const candidate of survivors) {
      const result = await deps.budget.check(entry, candidate, entry.config.models[candidate.agent])
      if (!result.ok) {
        notes.push({ kind: 'gate-failed', number: candidate.number, message: result.message })
        continue
      }
      const priorHolds = state.budgetHolds.get(candidate.number) ?? 0
      const route = budgetRoute(result.verdict, priorHolds)
      if (route.holds === 0) state.budgetHolds.delete(candidate.number)
      else state.budgetHolds.set(candidate.number, route.holds)

      if (route.action === 'dispatch') {
        kept.push(candidate)
        if (priorHolds > 0) notes.push({ kind: 'held-dispatched', number: candidate.number })
        continue
      }
      if (route.action === 'hold') {
        notes.push({ kind: 'held', number: candidate.number, line: result.line })
        continue
      }
      const item = candidate.kind === 'pull-request' ? env.itemsOf(entry.id).find((i) => i.number === candidate.number) : undefined
      await escalateOverBudget({ entry, candidate, line: result.line, notes, viewer, item, escalate: deps.escalate, dirs: deps.dirs })
    }
    state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, costUsd: state.budget?.costUsd ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
    return kept
  }

  async function launchSurvivors(pass: LaunchPass): Promise<void> {
    const { entry, survivors, resolvedByNumber, owner, runState, viewer } = pass
    const launch = deps.launch
    if (launch === null) return

    const gated = entry.config.commands.budget !== null ? await budgetGated(pass) : survivors
    if (gated.length === 0) {
      report(entry.id, owner, activeOrIdle(env.recordsOf(entry.id)), runState)
      return
    }

    const index = ticketIndex(env.itemsOf(entry.id))
    let waiting = 0
    await env.serialize(async () => {
      const limit = (await deps.store.capacity()).limit
      for (const candidate of gated) {
        if (env.isStopped()) break
        if (deps.runState(entry.id) !== RUN_TARGET.run) {
          waiting += 1
          continue
        }
        const free = freeSlots(limit, deps.store.list())
        if (free <= 0) {
          waiting += 1
          continue
        }
        let review: ReviewDispatchFacts | null = null
        if (candidate.agent === 'review') {
          if (candidate.cycle === null) {
            const message = `Couldn't count the earlier reviews on pull request #${candidate.number}, so the review wasn't started.`
            await recordFailure(entry, candidate, message)
            continue
          }
          review = reviewDispatchFacts({ priorReviews: candidate.cycle.count, author: resolvedByNumber.get(candidate.number)?.author ?? null, viewer })
        }
        const claimed = await claim(entry, candidate, resolvedByNumber.get(candidate.number))
        if (!claimed) continue
        try {
          const result = await launch.launch({
            entry,
            agent: candidate.agent,
            number: candidate.number,
            kind: candidate.kind,
            trigger: candidate.trigger,
            model: entry.config.models[candidate.agent],
            prompt: promptFor(candidate),
            title: ticketLabelFor(index, candidate.number, candidate.kind),
            target: targetOf(candidate.kind, resolvedByNumber.get(candidate.number)),
            review,
          })
          if (result.ok) {
            if (env.isStopped()) {
              void deps.store.close(result.sessionKey)
              continue
            }
            deps.forceDispatch.clear(entry.id, candidate.number)
          } else if (result.kind === 'at-capacity') {
            await rollback(entry, candidate)
            waiting += 1
          } else {
            await launchFailed(entry, candidate, result.cause, result.message, true)
          }
        } catch (error) {
          await launchFailed(entry, candidate, 'threw', error instanceof Error ? error.message : String(error), true)
        }
      }
    })

    const limit = (await deps.store.capacity()).limit
    if (waiting > 0) report(entry.id, owner, { kind: 'at-capacity', limit, waiting }, runState)
    else report(entry.id, owner, activeOrIdle(env.recordsOf(entry.id)), runState)
  }

  return { launchSurvivors }
}
