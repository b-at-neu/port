// Renderer-safe shapes for the two local sources the pipeline writes (#77):
// `git worktree list --porcelain` and `.agents/denials.log`. No import here
// may reach a Node builtin — apps/desktop/src/main/local/ is the only place
// that spawns `git` or reads the log, but the renderer is the eventual
// consumer of these shapes over IPC (#79/#80), so this file compiles under
// `typecheck:web` too. `LocalFailureKind` and `DenialsFailureKind` are
// hand-maintained literal unions for the same reason `PipelineFailureKind`
// is in `shared/github/types.ts`: the renderer cannot import the platform
// layer's real failure types, so `main/local/worktrees.ts` and
// `main/local/denials.ts` each pin their union against the real one with
// `AssertEqual`, and a new failure kind introduced there breaks
// `pnpm typecheck` here instead of silently landing in `unknown`.

export type CorrelationRung = 'upstream-branch' | 'branch-name' | 'directory-basename' | 'head-subject'

/** `{ number, rung }` when one of the four ladder rungs matched, byte-for-byte
 *  the reclaimer's own ladder (`templates/worktrees.mjs`'s `correlate`,
 *  pinned against this repository's TypeScript copy by the shared case
 *  table in `main/local/correlation.cases.json`). */
export interface WorktreeCorrelation {
  readonly number: number
  readonly rung: CorrelationRung
}

/** Set only when `correlation` is `null` — a rung that could not run
 *  (`subjects-unavailable`, because the batched `git log --no-walk` call
 *  itself failed) is never conflated with a rung that ran and found nothing
 *  (`no-rung-matched`). */
export type UnresolvedReason = 'no-rung-matched' | 'subjects-unavailable'

/** `impl-<n>` is an operator's own `/port:implement` worktree; `agent-*` is a
 *  dispatched agent's (`isolation: worktree`); anything else is `other` —
 *  never assumed to be one of the pipeline's own producers. */
export type WorktreeProducer = 'operator' | 'dispatched' | 'other'

export interface WorktreeEntry {
  readonly path: string
  /** `true` for the first stanza `git worktree list --porcelain` prints —
   *  the main checkout — `false` for every linked worktree. */
  readonly isMain: boolean
  readonly branch: string | null
  readonly head: string | null
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly lockReason: string | null
  /** The #62/#144 residue: the directory is gone but the entry remains. */
  readonly prunable: boolean
  readonly prunableReason: string | null
  readonly producer: WorktreeProducer
  /** `pathOps.contains(mainPath, path)` — never a string prefix test. */
  readonly insideMain: boolean
  readonly correlation: WorktreeCorrelation | null
  readonly unresolved: UnresolvedReason | null
}

/** Every failure kind `readWorktrees` can report — a flat literal union,
 *  hand-maintained rather than derived from `CommandResult` (see this
 *  file's header). Pinned in `main/local/worktrees.ts`. */
export type LocalFailureKind =
  | 'not-found'
  | 'cwd-missing'
  | 'nonzero'
  | 'signalled'
  | 'timeout'
  | 'output-too-large'
  | 'spawn-failed'
  | 'not-a-repository'

/** No `state`, no `removable`, no `done`/`active` vocabulary — this adapter
 *  is local-only (Decision 1) and never resolves an item's state; joining a
 *  worktree to an item's `gh`-resolved state is #79's job. */
export type WorktreesRead =
  | {
      readonly ok: true
      readonly mainPath: string
      readonly entries: readonly WorktreeEntry[]
      /** `false` when the batched `git log --no-walk` call itself failed —
       *  every entry the other three rungs could not resolve reports
       *  `unresolved: 'subjects-unavailable'`, never `'no-rung-matched'`. */
      readonly subjectsAvailable: boolean
      readonly readAt: string
    }
  | {
      readonly ok: false
      readonly kind: LocalFailureKind
      readonly message: string
      readonly readAt: string
    }

/** `deny`/`miss`/`gate-clear`/`hook-error` — the four-field current form's
 *  own vocabulary (`PIPELINE.md` → "Denial visibility"). A legacy three-field
 *  line carries no decision at all, so `DenialEntry.decision` is `null` for
 *  one. */
export type DenialDecision = 'deny' | 'miss' | 'gate-clear' | 'hook-error'

/** Attribution is *partly* reliable, not uniformly unreliable (the plan's
 *  correction to the ticket's stale premise): a `stage-agent` or `subagent`
 *  actor is attributable, a `session` or `unattributed` actor never is —
 *  nothing in either line distinguishes the cockpit, `/port:implement`, or
 *  an unrelated human session. */
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
  /** `null` for a `legacy` or `malformed` line — a legacy line never carried
   *  a decision field at all. */
  readonly decision: DenialDecision | null
  /** `null` only for a `malformed` line the actor ladder could not even
   *  attempt to parse. */
  readonly actor: DenialActor | null
  readonly subject: string | null
}

/** The buckets a consumer must never re-derive by filtering `entries` itself
 *  (Data & contracts): every wrong reading of this log has come from
 *  collapsing these back together. `total` counts every line in the file,
 *  independent of `limit`, so a cap can only understate `entries`, never
 *  `total`. */
export interface DenialSummary {
  /** `deny` from a `stage-agent` or `subagent` actor — a dispatched agent
   *  hit the allowlist. */
  readonly agentDenials: number
  /** `deny` from a `session` actor — a rail held (the cockpit's own loop,
   *  gate, or install rule), never a missing permission. Never added to
   *  `agentDenials`. */
  readonly railDenials: number
  /** `miss` — a non-subagent allowlist miss, logged for visibility and
   *  never denied. The #63 false-positive class; never a denial. */
  readonly misses: number
  /** `gate-clear` — an allowed, authorised `needs human` removal. An audit
   *  record, not a denial. */
  readonly gateClears: number
  /** `hook-error` — a fail-open hook failure. */
  readonly hookErrors: number
  readonly legacy: number
  readonly malformed: number
  readonly total: number
}

/** Every failure kind `readDenials` can report — `not-found` becomes
 *  `present: false` and a text read can never be `unparseable`, so both are
 *  excluded from the platform layer's `FileFailureKind`. Pinned in
 *  `main/local/denials.ts`. */
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
      /** `true` when `entries` holds fewer than `summary.total` lines — the
       *  newest `limit` (default 500), oldest first. */
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
