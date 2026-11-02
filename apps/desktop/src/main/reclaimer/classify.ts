// Pure decisions, each pinned against the shipped reclamation script by `classify.cases.json`.
import type { ItemStateName } from '@/types/github'
import type { CorrelationRung } from '@/types/local'
import type { OrphanInput, PurgeCause, WorktreeState } from '@/types/reclaimer'

export interface ClassifyInput {
  readonly isOutside: boolean
  readonly isProtected: boolean
  readonly locked: boolean
  readonly dirty: boolean
  /** Only a correlated worktree has one; `null` means unknown, never done. */
  readonly itemState: ItemStateName | null
  /** Only consulted when `itemState` is `null`. */
  readonly isAncestor: boolean | null
}

export interface Classified {
  readonly state: WorktreeState
  readonly removable: boolean
  /** Finished work that only a lock or uncommitted changes keep from `removable`. */
  readonly otherwiseRemovable: boolean
}

/** Precedence: outside, protected, locked, dirty, active, done or no-work, unresolved. */
export function classifyCandidate(input: ClassifyInput): Classified {
  if (input.isOutside) return { state: 'outside', removable: false, otherwiseRemovable: false }
  if (input.isProtected) return { state: 'active', removable: false, otherwiseRemovable: false }

  let base: WorktreeState
  if (input.itemState === 'OPEN') base = 'active'
  else if (input.itemState === 'CLOSED' || input.itemState === 'MERGED') base = 'done'
  else if (input.itemState === null && input.isAncestor === true) base = 'no-work'
  else base = 'unresolved'

  const otherwiseRemovable = base === 'done' || base === 'no-work'
  if (input.locked) return { state: 'locked', removable: false, otherwiseRemovable }
  if (otherwiseRemovable && input.dirty) return { state: 'dirty', removable: false, otherwiseRemovable: true }
  return { state: base, removable: otherwiseRemovable, otherwiseRemovable }
}

export interface FallbackInput {
  readonly dirExists: boolean
  readonly stillRegistered: boolean
  readonly headNow: string | null
  readonly headClassified: string | null
}

export type FallbackDecision = { readonly action: 'done' | 'fallback' } | { readonly action: 'abort'; readonly reason: string }

/** What follows a removal that git has already attempted once. */
export function fallbackDecision(input: FallbackInput): FallbackDecision {
  if (!input.dirExists) return { action: 'done' }
  if (!input.stillRegistered) return { action: 'fallback' }
  if (input.headNow === input.headClassified) return { action: 'fallback' }
  return { action: 'abort', reason: 'changed during removal' }
}

/** Tells a live independent repository (`.git` dir) from a worktree's own `.git` file whose target is forgotten. */
export function orphanVerdict(input: OrphanInput): 'skip' | 'orphan' {
  if (input.gitEntry === 'dir' || input.gitEntry === 'unreadable') return 'skip'
  if (input.gitEntry === 'file') return input.gitdirTargetExists ? 'skip' : 'orphan'
  return 'orphan'
}

/** `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` mean a file is still open; `ENAMETOOLONG` is Windows. */
export function classifyRemovalFailure(code: string | null): PurgeCause {
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'ENOTEMPTY') return 'file-in-use'
  if (code === 'ENAMETOOLONG') return 'long-path'
  return 'unknown'
}

export interface ReasonInput {
  readonly state: WorktreeState
  readonly path: string
  readonly itemState: ItemStateName | null
  readonly correlation: { readonly number: number; readonly rung: CorrelationRung } | null
  readonly lockReason: string | null
  readonly otherwiseRemovable: boolean
  /** `-1` means the status could not be read. */
  readonly dirtyFiles: number
}

function lockedReason(input: ReasonInput): string {
  const base = input.lockReason !== null ? `locked: ${input.lockReason}` : 'locked'
  // A lock is only called reclaimable once its item is done, so an operator is never walked into unlocking a live agent.
  if (!input.otherwiseRemovable) return base
  const dirtyClause = input.dirtyFiles === -1 ? '; uncommitted status could not be checked too' : input.dirtyFiles > 0 ? `; ${String(input.dirtyFiles)} uncommitted file(s) too` : ''
  const forcedFlag = input.dirtyFiles !== 0 ? ' and forced' : ''
  return `${base}${dirtyClause} — reclaimable once unlocked${dirtyClause !== '' ? forcedFlag : ''}: git worktree unlock "${input.path}"`
}

export function describeReason(input: ReasonInput): string {
  const issue = input.correlation === null ? null : input.correlation.number
  switch (input.state) {
    case 'active':
      return input.itemState === 'OPEN' && issue !== null ? `#${String(issue)} open` : 'protected'
    case 'done':
      return `#${String(issue)} ${input.itemState === 'MERGED' ? 'merged' : 'closed'} (${input.correlation?.rung ?? 'unknown'})`
    case 'no-work':
      return 'no work not already on the integration branch'
    case 'locked':
      return lockedReason(input)
    case 'dirty': {
      const prefix = issue !== null ? `#${String(issue)} ` : ''
      const count = input.dirtyFiles === -1 ? 'an unknown number of' : String(input.dirtyFiles)
      return `${prefix}otherwise reclaimable, but ${count} uncommitted file(s)`
    }
    case 'outside':
      return 'registered path is outside the main worktree — never touched'
    case 'unresolved':
      return issue !== null ? `#${String(issue)} could not be resolved` : 'no upstream branch, no #N subject, and HEAD is not on the integration branch'
  }
}
