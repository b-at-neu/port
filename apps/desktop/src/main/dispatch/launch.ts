import type { ReadyEntry } from '@/types/actions'
import type { BudgetNote, DispatchOwner, RunState, StageLaunchFailureCause } from '@/types/dispatch'
import { RUN_TARGET } from '@/types/dispatch'
import type { PipelineItemKind, ResolvedItem } from '@/types/github'
import type { HostedSessionSnapshot } from '@/types/hosting'
import type { ReconciledItem } from '@/types/state'
import type { TickActionable } from '@/types/tick'
import type { StageWorktreeTarget } from '@/types/workspace'
import type { Ticket } from '@/utils/pipeline/ticket'
import { reviewDispatchFacts } from '@/utils/pipeline/gates'
import type { ReviewDispatchFacts } from '@/utils/pipeline/gates'
import { KIND_PROMPT_NAMES, STAGE_PROMPT_NAMES } from '@/utils/stage/prompt'
import { ticketIndex, ticketLabelFor } from '@/utils/tickets/ticket'
import { budgetRoute, escalateOverBudget } from '@/main/dispatch/budget'
import { budgetCheck } from '@/main/dispatch/budget-gate'
import type { DispatchContext } from '@/main/dispatch/context'
import type { RepoDispatcherState } from '@/main/dispatch/records'
import { applyStageClaim, applyStageTransition } from '@/main/pipeline/operator/stage'
import { createRaiser, launchFailedIntent } from '@/main/pipeline/incidents/raise'

const NOTE_LIMIT = 20

/** The text the stage session's first message opens with; port has already moved the label, so no agent step names one. */
export const DISPATCH_PROMPT = '<Stage> stage for <kind> #<n>. Run your pipeline stage for #<n>. port has already moved its label. Follow your Pre-flight, Work, and Handoff steps exactly.'
export const REFRESH_PROMPT = 'Refresh stage for pull request #<n>. Run your pipeline stage for pull request #<n> in refresh mode.'

/** A `StageLaunchRequest.prompt` is filled from this, never re-derived at the launcher. */
export function promptFor(actionable: Pick<TickActionable, 'stage' | 'number' | 'agent' | 'kind'>): string {
  const n = String(actionable.number)
  if (actionable.stage === 'refresh') return REFRESH_PROMPT.replaceAll('<n>', n)
  return DISPATCH_PROMPT.replaceAll('<Stage>', STAGE_PROMPT_NAMES[actionable.agent]).replaceAll('<kind>', KIND_PROMPT_NAMES[actionable.kind]).replaceAll('<n>', n)
}

/** The re-read survivor test: the ticket is still queued at the candidate's stage and the viewer is still an assignee. A missing ticket launches nothing this tick. */
export function survived(resolved: ResolvedItem, candidate: TickActionable, viewer: string, ticket: Pick<Ticket, 'stage' | 'status'> | null): boolean {
  if (ticket === null || ticket.stage !== candidate.stage || ticket.status.kind !== 'queued') return false
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

export interface LaunchPass {
  readonly entry: ReadyEntry
  readonly survivors: readonly TickActionable[]
  readonly resolvedByNumber: ReadonlyMap<number, ResolvedItem>
  readonly state: RepoDispatcherState
  readonly owner: DispatchOwner
  readonly runState: RunState
  readonly viewer: string
  readonly items: readonly ReconciledItem[]
}

/** A launch that never produced a session still shows as a run, ended the instant it started. */
async function recordFailure(ctx: DispatchContext, entry: ReadyEntry, candidate: TickActionable, message: string): Promise<void> {
  await ctx.stores.runs.launchFailed(entry.id, { stage: candidate.stage, kind: candidate.kind, number: candidate.number, agent: candidate.agent, model: entry.config.models[candidate.agent], title: null, message })
}

/** Undoes a claim whose launch failed; a refused rollback is left to the stall ladder. */
async function rollback(ctx: DispatchContext, entry: ReadyEntry, candidate: TickActionable): Promise<void> {
  await applyStageTransition(ctx, { entry, record: candidate, event: { kind: 'rollback' }, auditDir: ctx.paths.userData, scratchDir: ctx.paths.temp })
}

/** A launch that never produced a session: undoes the claim when it made one, records the failure and raises its incident. */
async function launchFailed(ctx: DispatchContext, entry: ReadyEntry, candidate: TickActionable, cause: StageLaunchFailureCause | `claim-${string}`, message: string, undo: boolean): Promise<void> {
  if (undo) await rollback(ctx, entry, candidate)
  await recordFailure(ctx, entry, candidate, message)
  createRaiser(ctx.stores.incidentLog.record, () => entry.config.repo)(entry.id, candidate, launchFailedIntent(candidate, cause), { kind: 'failed' })
}

/** Trigger → in-flight before the session exists. `moved` skips silently, since the next read shows the truth; any other refusal is a launch failure. */
async function claim(ctx: DispatchContext, entry: ReadyEntry, candidate: TickActionable, resolved: ResolvedItem | undefined): Promise<boolean> {
  if (resolved === undefined) return false
  const result = await applyStageClaim(ctx, { entry, candidate, resolved, auditDir: ctx.paths.userData })
  if (result.kind === 'applied') return true
  if (result.reason !== 'moved') await launchFailed(ctx, entry, candidate, `claim-${result.reason}`, `port couldn't move the label before starting: ${result.reason}${result.detail === null ? '' : ` (${result.detail})`}`, false)
  return false
}

/** The budget gate per candidate: dispatched, held for one pass, or escalated to a human. */
export async function budgetGated(ctx: DispatchContext, pass: LaunchPass): Promise<readonly TickActionable[]> {
  const { entry, survivors, state, viewer } = pass
  const notes: BudgetNote[] = []
  const kept: TickActionable[] = []
  for (const candidate of survivors) {
    const result = await budgetCheck(ctx, entry, candidate, entry.config.models[candidate.agent])
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
    const item = candidate.kind === 'pull-request' ? pass.items.find((i) => i.number === candidate.number) : undefined
    await escalateOverBudget(ctx, { entry, candidate, line: result.line, notes, viewer, item })
  }
  state.budget = { line: state.budget?.line ?? null, problem: state.budget?.problem ?? null, costUsd: state.budget?.costUsd ?? null, notes: notes.length > NOTE_LIMIT ? notes.slice(notes.length - NOTE_LIMIT) : notes }
  return kept
}

/** Launches each gated candidate in turn and returns how many had to wait for a slot. The caller serializes it, so two repositories never race for the same free slot. */
export async function launchGated(ctx: DispatchContext, pass: LaunchPass, gated: readonly TickActionable[], isStopped: () => boolean): Promise<number> {
  const { entry, resolvedByNumber, viewer } = pass
  const { hostedStore, stageLauncher } = ctx.live
  const index = ticketIndex(pass.items)
  let waiting = 0
  const limit = (await hostedStore.capacity()).limit
  for (const candidate of gated) {
    if (isStopped()) break
    if (ctx.stores.runStates.current(entry.id).state !==RUN_TARGET.run) {
      waiting += 1
      continue
    }
    const free = freeSlots(limit, hostedStore.list())
    if (free <= 0) {
      waiting += 1
      continue
    }
    let review: ReviewDispatchFacts | null = null
    if (candidate.agent === 'review') {
      if (candidate.cycle === null) {
        const message = `Couldn't count the earlier reviews on pull request #${candidate.number}, so the review wasn't started.`
        await recordFailure(ctx, entry, candidate, message)
        continue
      }
      review = reviewDispatchFacts({ priorReviews: candidate.cycle.count, author: resolvedByNumber.get(candidate.number)?.author ?? null, viewer })
    }
    const claimed = await claim(ctx, entry, candidate, resolvedByNumber.get(candidate.number))
    if (!claimed) continue
    try {
      const result = await stageLauncher.launch({
        entry,
        agent: candidate.agent,
        stage: candidate.stage,
        number: candidate.number,
        kind: candidate.kind,
        mode: candidate.mode,
        model: entry.config.models[candidate.agent],
        prompt: promptFor(candidate),
        title: ticketLabelFor(index, candidate.number, candidate.kind),
        target: targetOf(candidate.kind, resolvedByNumber.get(candidate.number)),
        review,
      })
      if (result.ok) {
        if (isStopped()) {
          void hostedStore.close(result.sessionKey)
          continue
        }
        ctx.live.memos.forceDispatch.clear(entry.id, candidate.number)
      } else if (result.kind === 'at-capacity') {
        await rollback(ctx, entry, candidate)
        waiting += 1
      } else {
        await launchFailed(ctx, entry, candidate, result.cause, result.message, true)
      }
    } catch (error) {
      await launchFailed(ctx, entry, candidate, 'threw', error instanceof Error ? error.message : String(error), true)
    }
  }
  return waiting
}
