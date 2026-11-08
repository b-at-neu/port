// Tracks the issues-list pre-check per repository and answers when it, or the sweep it triggered, is next due. It names no timer: the watcher's one clock reads `nextDueAt`.
import { GITHUB_PRECHECK_INTERVAL_MS, initialHealth, isDeferred } from '@/types/board'
import type { SourceHealth } from '@/types/board'
import type { StateEngine } from '@/types/offload'
import type { GithubPrecheckOutcome } from '@/types/state'
import type { RepoId } from '@/utils/repos'
import { afterFailure, nextDueAt as healthDueAt } from '@/main/state/schedule'

interface PrecheckState {
  readonly health: SourceHealth
  readonly pendingSince: string | null
  readonly inFlight: boolean
}

interface RepoRef {
  readonly repoId: RepoId
  readonly repo: { readonly owner: string; readonly name: string }
}

function initialState(): PrecheckState {
  return { health: { ...initialHealth('github'), intervalMs: GITHUB_PRECHECK_INTERVAL_MS }, pendingSince: null, inFlight: false }
}

/** Null when a pre-check would only spend REST calls: a sweep is already coming, already due, or impossible yet. */
export function precheckDueAt(state: PrecheckState, github: SourceHealth, now: Date): Date | null {
  if (state.inFlight || state.pendingSince !== null) return null
  if (github.lastSuccessAt === null || isDeferred(github, now)) return null
  if (healthDueAt(github, now).getTime() <= now.getTime()) return null
  return healthDueAt(state.health, now)
}

/** The earliest instant the pending sweep may run: one budget gap after the last sweep, and never inside a deferral. */
export function pendingSweepAt(state: PrecheckState, github: SourceHealth, gapMs: number): Date | null {
  if (state.pendingSince === null) return null
  const lastAttempt = github.lastAttemptAt === null ? 0 : Date.parse(github.lastAttemptAt)
  const afterGap = Number.isNaN(lastAttempt) ? 0 : lastAttempt + gapMs
  const deferred = github.deferredUntil === null ? 0 : Date.parse(github.deferredUntil)
  return new Date(Math.max(afterGap, Number.isNaN(deferred) ? 0 : deferred))
}

interface GithubPrecheckParams {
  readonly engine: Pick<StateEngine, 'precheckGithub'>
  readonly now: () => Date
}

export interface GithubPrecheck {
  nextDueAt(repoId: RepoId, github: SourceHealth, gapMs: number): Date | null
  run(target: RepoRef, github: SourceHealth): Promise<void>
  wantsSweep(repoId: RepoId, github: SourceHealth, gapMs: number): boolean
  settled(repoId: RepoId, startedAt: string, ok: boolean): void
}

/** A pre-check failure only backs the pre-check off — it never touches GitHub health, so the regular sweep carries on as before. */
export function createGithubPrecheck(params: GithubPrecheckParams): GithubPrecheck {
  const states = new Map<RepoId, PrecheckState>()

  function stateOf(repoId: RepoId): PrecheckState {
    return states.get(repoId) ?? initialState()
  }

  function update(repoId: RepoId, patch: Partial<PrecheckState>): void {
    states.set(repoId, { ...stateOf(repoId), ...patch })
  }

  return {
    nextDueAt(repoId, github, gapMs) {
      const state = stateOf(repoId)
      const candidates = [precheckDueAt(state, github, params.now()), pendingSweepAt(state, github, gapMs)].filter((at): at is Date => at !== null)
      return candidates.length === 0 ? null : new Date(Math.min(...candidates.map((at) => at.getTime())))
    },

    async run({ repoId, repo }, github) {
      const due = precheckDueAt(stateOf(repoId), github, params.now())
      if (due === null || due.getTime() > params.now().getTime()) return
      update(repoId, { inFlight: true })
      try {
        const outcome = await params.engine.precheckGithub({ repoId, repo }).catch((error: unknown): GithubPrecheckOutcome => ({ ok: false, at: params.now().toISOString(), error: error instanceof Error ? error.message : String(error) }))
        const state = stateOf(repoId)
        if (outcome.ok) {
          const health: SourceHealth = { lastSuccessAt: outcome.at, lastAttemptAt: outcome.at, consecutiveFailures: 0, lastError: null, intervalMs: GITHUB_PRECHECK_INTERVAL_MS, deferredUntil: null }
          update(repoId, { health, pendingSince: outcome.changed ? (state.pendingSince ?? outcome.at) : state.pendingSince })
        } else {
          update(repoId, { health: afterFailure(state.health, 'github', new Date(outcome.at), outcome.error) })
        }
      } finally {
        update(repoId, { inFlight: false })
      }
    },

    wantsSweep(repoId, github, gapMs) {
      const at = pendingSweepAt(stateOf(repoId), github, gapMs)
      return at !== null && at.getTime() <= params.now().getTime()
    },

    // A change seen while a sweep was already reading survives it: only a sweep that started after the change can have seen it.
    settled(repoId, startedAt, ok) {
      const { pendingSince } = stateOf(repoId)
      if (!ok || pendingSince === null || Date.parse(pendingSince) > Date.parse(startedAt)) return
      update(repoId, { pendingSince: null })
    },
  }
}
