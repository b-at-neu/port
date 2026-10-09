// Renderer-safe shapes for the worktree inspector: driving the shipped worktrees script and joining the local read for the one fact its JSON omits (`prunable`). No import here may reach a Node builtin.
import type { CorrelationRung, WorktreeProducer } from '../local/types'

/** Byte-for-byte `bin/worktrees.mjs`'s own state vocabulary. A `state` the app does not know is never widened to a string; `parse.ts` fails the whole payload with `report-unparseable` instead. */
export const WORKTREE_STATES = ['active', 'done', 'no-work', 'locked', 'dirty', 'outside', 'unresolved'] as const

export type WorktreeState = (typeof WORKTREE_STATES)[number]

/** The states `classifyCandidate` can report as `removable: true` — `reclaimable` is always derived from this list, never from parsing `reason` prose. */
export const RECLAIMABLE_STATES = ['done', 'no-work'] as const

export type ReclaimableState = (typeof RECLAIMABLE_STATES)[number]

export function isReclaimableState(state: WorktreeState): state is ReclaimableState {
  return (RECLAIMABLE_STATES as readonly string[]).includes(state)
}

/** One worktree row, joined from the script's `--json` payload and, when available, the local `readWorktrees`. `prunable`/`producer` are `null` only when that join failed. `reason` is the script's own sentence, passed through verbatim. */
export interface InspectedWorktree {
  readonly path: string
  /** Computed in `main/reclaimer/report.ts` — the renderer never manipulates a path itself, only displays the native string main resolved. */
  readonly pathBasename: string
  readonly branch: string | null
  readonly head: string | null
  readonly state: WorktreeState
  readonly reason: string
  readonly issue: number | null
  readonly rung: CorrelationRung | null
  readonly locked: boolean
  readonly lockReason: string | null
  readonly dirtyFiles: number
  readonly reclaimable: boolean
  readonly prunable: boolean | null
  readonly producer: WorktreeProducer | null
}

/** Every failure kind `readWorktreeReport` can report. The first five are this adapter's own, layered above the platform layer's `CommandResult` kinds. */
export type ReclaimerFailureKind =
  | 'not-configured'
  | 'unparseable-command'
  | 'unsupported-runner'
  | 'script-failed'
  | 'report-unparseable'
  | 'not-found'
  | 'cwd-missing'
  | 'nonzero'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'

export type ReclaimerFailure =
  | { readonly kind: 'unsupported-runner'; readonly token: string; readonly message: string }
  | { readonly kind: Exclude<ReclaimerFailureKind, 'unsupported-runner'>; readonly message: string }

/** `'unavailable'` means a `nonzero` exit retried once with `--offline`. In that state a finished worktree reports `unresolved`, never `done` — the under-reporting is deliberate. */
export type GithubResolutionState = 'resolved' | 'unavailable'

/** `'unavailable'` means the local `readWorktrees` itself failed — `prunable`/`producer` are `null` on every row, and the report is still `ok: true`. */
export type PorcelainJoinState = 'joined' | 'unavailable'

export type WorktreesReport =
  | {
      readonly ok: true
      readonly mainRoot: string
      readonly integrationRef: string
      readonly worktrees: readonly InspectedWorktree[]
      readonly orphanDirs: readonly string[]
      readonly registered: number
      readonly byState: Readonly<Partial<Record<WorktreeState, number>>>
      readonly githubResolution: GithubResolutionState
      readonly porcelainJoin: PorcelainJoinState
      readonly readAt: string
    }
  | ({ readonly ok: false; readonly readAt: string } & ReclaimerFailure)
