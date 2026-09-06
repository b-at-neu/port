// Renderer-safe shapes for the worktree inspector (#86): driving the shipped
// `plugins/port/templates/worktrees.mjs report --json` through
// `commands.worktrees` and joining #77's local read for the one fact the
// script's own JSON omits (`prunable`). No import here may reach a Node
// builtin — apps/desktop/src/main/reclaimer/ is the only place that spawns
// `node`, but the renderer is this ticket's own consumer, so this file
// compiles under `typecheck:web` too. `ReclaimerFailureKind` is a
// hand-maintained literal union for the same reason `LocalFailureKind` is in
// `shared/local/types.ts`: the renderer cannot import the platform layer's
// real failure types, so `main/reclaimer/report.ts` pins its union against
// the real one with `AssertEqual`.
import type { CorrelationRung, WorktreeProducer } from '../local/types'

/** Byte-for-byte `templates/worktrees.mjs`'s own state vocabulary — pinned
 *  against the template's `describeReason` `case` labels, both directions,
 *  by the `desktop-reclaimer` layer 1 check. A `state` the app does not know
 *  is never widened to a string; `parse.ts` fails the whole payload with
 *  `report-unparseable` instead (ENGINEERING §4). */
export const WORKTREE_STATES = ['active', 'done', 'no-work', 'locked', 'dirty', 'outside', 'unresolved'] as const

export type WorktreeState = (typeof WORKTREE_STATES)[number]

/** The states `templates/worktrees.mjs`'s `classifyCandidate` can report as
 *  `removable: true` — pinned against the template's real export by the same
 *  `desktop-reclaimer` check, so `reclaimable` is always derived from this
 *  list, never from parsing `reason` prose (Decision 4). */
export const RECLAIMABLE_STATES = ['done', 'no-work'] as const

export type ReclaimableState = (typeof RECLAIMABLE_STATES)[number]

export function isReclaimableState(state: WorktreeState): state is ReclaimableState {
  return (RECLAIMABLE_STATES as readonly string[]).includes(state)
}

/** One worktree row, joined from the script's `--json` payload and, when
 *  available, #77's `readWorktrees` (Decision 1). `prunable`/`producer` are
 *  `null` only when that join itself failed — never silently omitted; see
 *  `porcelainJoin` on the report. `dirtyFiles: -1` is the script's own
 *  "unknown count" sentinel, never a real count. `reason` is the script's
 *  own sentence, passed through verbatim — never re-summarised. */
export interface InspectedWorktree {
  readonly path: string
  /** `pathOps.basename(path)`, computed in `main/reclaimer/report.ts` — the
   *  renderer never manipulates a path itself (ENGINEERING §1), only
   *  displays the native string main resolved. */
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

/** Every failure kind `readWorktreeReport` can report. The first five are
 *  this adapter's own, layered above the platform layer's `CommandResult`
 *  kinds (`not-found`…`spawn-failed`), pinned together in `report.ts`. */
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

/** `'unavailable'` means a `nonzero` exit whose stderr carried the sentinel
 *  `gh issueOrPullRequest resolution failed` sentence, retried once with
 *  `--offline` (Decision 3). In that state a finished worktree reports
 *  `unresolved`, never `done` — the under-reporting is deliberate. */
export type GithubResolutionState = 'resolved' | 'unavailable'

/** `'unavailable'` means #77's `readWorktrees` itself failed — `prunable`
 *  and `producer` are `null` on every row, and the report is still `ok:
 *  true` (Decision 1's join never fails the whole read). */
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
