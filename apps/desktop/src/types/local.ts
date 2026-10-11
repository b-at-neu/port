// Renderer-safe shapes for the two local sources the pipeline writes: `git worktree list --porcelain` and `.agents/denials.log`. No import here may reach a Node builtin. `LocalFailureKind` and `DenialsFailureKind` are hand-maintained, pinned against the real platform-layer types with `AssertEqual` so a new failure kind there breaks `pnpm typecheck` here rather than silently landing in `unknown`.

export type CorrelationRung = 'upstream-branch' | 'branch-name' | 'directory-basename' | 'head-subject'

/** `{ number, rung }` when one of the four ladder rungs matched, pinned against the reclaimer's own ladder by a shared case table. */
export interface WorktreeCorrelation {
  readonly number: number
  readonly rung: CorrelationRung
}

/** Set only when `correlation` is `null` — a rung that could not run (`subjects-unavailable`) is never conflated with one that ran and found nothing (`no-rung-matched`). */
export type UnresolvedReason = 'no-rung-matched' | 'subjects-unavailable'

/** `impl-<n>` is an operator's own `/port:implement` worktree; `agent-*` is a dispatched agent's; anything else is `other`. */
export type WorktreeProducer = 'operator' | 'dispatched' | 'other'

export interface WorktreeEntry {
  readonly path: string
  /** `true` for the first stanza — the main checkout — `false` for every linked worktree. */
  readonly isMain: boolean
  readonly branch: string | null
  readonly head: string | null
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason: string | null
  /** The directory is gone but the entry remains. */
  readonly prunable: boolean
  readonly prunableReason: string | null
  readonly producer: WorktreeProducer
  /** `pathOps.contains(mainPath, path)` — never a string prefix test. */
  readonly insideMain: boolean
  readonly correlation: WorktreeCorrelation | null
  readonly unresolved: UnresolvedReason | null
}

/** Every failure kind `readWorktrees` can report — hand-maintained, pinned in `main/local/worktrees.ts`. */
export type LocalFailureKind =
  | 'not-found'
  | 'cwd-missing'
  | 'nonzero'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'
  | 'not-a-repository'

/** No `state`, no `removable`, no `done`/`active` vocabulary — this adapter is local-only and never resolves an item's state. */
export type WorktreesRead =
  | {
      readonly ok: true
      readonly mainPath: string
      readonly entries: readonly WorktreeEntry[]
      /** `false` when the batched `git log --no-walk` call failed; unresolved entries then report `'subjects-unavailable'`, never `'no-rung-matched'`. */
      readonly subjectsAvailable: boolean
      readonly readAt: string
    }
  | {
      readonly ok: false
      readonly kind: LocalFailureKind
      readonly message: string
      readonly readAt: string
    }

/** The four-field current form's own vocabulary. A legacy three-field line carries no decision, so `DenialEntry.decision` is `null` for one. */
export type DenialDecision = 'deny' | 'miss' | 'gate-clear' | 'hook-error'

/** Attribution is partly reliable: a `stage-agent` or `subagent` actor is attributable, a `session` or `unattributed` actor never is. */
export type DenialActor =
  | { readonly kind: 'stage-agent'; readonly agent: 'plan-agent' | 'impl-agent' | 'review-agent' | 'revise-agent' }
  | { readonly kind: 'subagent'; readonly agentType: string }
  | { readonly kind: 'subagent-signal'; readonly signal: string }
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'unattributed'; readonly raw: string }

export type DenialForm = 'current' | 'legacy' | 'malformed'

export interface DenialEntry {
  readonly raw: string
  readonly form: DenialForm
  readonly timestamp: string | null
  /** `null` for a `legacy` or `malformed` line — a legacy line never carried a decision field. */
  readonly decision: DenialDecision | null
  /** `null` only for a `malformed` line the actor ladder could not parse. */
  readonly actor: DenialActor | null
  readonly subject: string | null
}

/** The buckets a consumer must never re-derive by filtering `entries` itself. `total` counts every line in the file, independent of `limit`. */
export interface DenialSummary {
  /** `deny` from a `stage-agent` or `subagent` actor — a dispatched agent hit the allowlist. */
  readonly agentDenials: number
  /** `deny` from a `session` actor — a rail held, never a missing permission. Never added to `agentDenials`. */
  readonly railDenials: number
  /** `miss` — a non-subagent allowlist miss, logged for visibility and never denied. */
  readonly misses: number
  /** `gate-clear` — an allowed, authorised `needs human` or operator-named `approved` removal. An audit record, not a denial. */
  readonly gateClears: number
  /** `hook-error` — a fail-open hook failure. */
  readonly hookErrors: number
  readonly legacy: number
  readonly malformed: number
  readonly total: number
}

/** Every failure kind `readDenials` can report — `not-found` becomes `present: false`, so both it and `unparseable` are excluded here. Pinned in `main/local/denials.ts`. */
export type DenialsFailureKind = 'not-a-file' | 'permission-denied' | 'too-large' | 'io'

/** An absent log is a distinct healthy state (`present: false`), never an
 *  error and never an empty `entries` list that reads as "no denials". */
export type DenialsRead =
  | { readonly ok: true; readonly present: false; readonly path: string; readonly readAt: string }
  | {
      readonly ok: true
      readonly present: true
      readonly path: string
      readonly entries: readonly DenialEntry[]
      readonly summary: DenialSummary
      /** `true` when `entries` holds fewer than `summary.total` lines — the newest `limit` (default 500), oldest first. */
      readonly capped: boolean
      readonly readAt: string
    }
  | {
      readonly ok: false
      readonly kind: DenialsFailureKind
      readonly message: string
      readonly path: string
      readonly readAt: string
    }
