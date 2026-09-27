// Renderer-safe relay shapes (#107). No import here may reach a Node
// builtin or `src/main/` — `main/relay/read.ts` is the only place that
// touches a transcript on disk, but the renderer is this ticket's own
// consumer over `BoardSnapshot`, so this file compiles under
// `typecheck:web` too (the same contract `shared/sessions/types.ts` and
// `shared/gate/types.ts` already hold for themselves).
import type { RepoId } from '../repos'
import type { PortStageAgent, SessionFailureKind } from '../sessions/types'

/** The two markers a stage agent's final message ends with when it needs a
 *  human, plus the usage-limit class the relay loop also reports but never
 *  offers a compose form for. */
export type RelayKind = 'questions' | 'blocked' | 'usage-limit'

/** `classifyFinalMessage`'s own return domain: the three `RelayKind`s, plus
 *  `completed` (nothing pending) and `indeterminate` (a tail that could not
 *  be read, or one with no assistant text after the widened window). */
export type RelayVerdict = RelayKind | 'completed' | 'indeterminate'

/** One numbered line under `QUESTIONS FOR HUMAN:`, in the order it appeared
 *  — `index` is zero-based and is also the answer array's own position, so
 *  `composeReply` never has to re-derive it. */
export interface RelayQuestion {
  readonly index: number
  readonly text: string
}

interface RelayPendingBase {
  readonly repoId: RepoId | null
  /** `null` when the agent's own `description` carried no `#N` — a pending
   *  relay whose number matches no board row still appears in
   *  `BoardProjection.relays`, never dropped for having no home. */
  readonly number: number | null
  readonly stage: PortStageAgent
  readonly sessionId: string
  readonly agentId: string | null
  /** The cockpit session's own label — where the operator pastes a composed
   *  reply back, since the send itself is out of this ticket's scope. */
  readonly parentSessionLabel: string
  readonly agentLabel: string
  readonly lastActivityAt: string
}

/**
 * One switch per union member (the same rule `board/tick.ts`/`board/copy.ts`
 * already state) — a new `RelayKind` is a compile error here, never a
 * silently blank line. `usage-limit` carries no payload: it is reported,
 * never relayable, per `pipeline/SKILL.md`'s own "Agent questions and
 * blockers" — the class that must never be redispatched or composed a reply
 * for.
 */
export type RelayPending =
  | (RelayPendingBase & { readonly kind: 'questions'; readonly questions: readonly RelayQuestion[] })
  | (RelayPendingBase & { readonly kind: 'blocked'; readonly request: string })
  | (RelayPendingBase & { readonly kind: 'usage-limit' })

/** `RelayPending` minus the base identity fields — `classify.ts`'s
 *  `relayPayloadOf` returns exactly this, and `main/relay/read.ts` spreads it
 *  onto the base fields it alone knows (the candidate's own identity), so the
 *  pure parser never has to see a `RepoId` or a session id. */
export type RelayPayload = Pick<Extract<RelayPending, { kind: 'questions' }>, 'kind' | 'questions'> | Pick<Extract<RelayPending, { kind: 'blocked' }>, 'kind' | 'request'> | Pick<Extract<RelayPending, { kind: 'usage-limit' }>, 'kind'>

/**
 * Direction of failure: closed on the answer, open on reporting (ENGINEERING
 * §4) — no path returns `pending: []` for a scan that did not run.
 * `ok: false` carries a `SessionFailureKind`-shaped reason, since a relay
 * scan can only ever fail the way the session scan it reads already fails.
 */
export type RelayScan =
  | {
      readonly ok: true
      readonly pending: readonly RelayPending[]
      /** Every candidate whose transcript this pass actually attempted to
       *  read this poll, whether or not a definite verdict resulted. */
      readonly checked: number
      /** The subset of `checked` (plus anything the candidate cap or time
       *  budget cut before it could even be attempted) that never produced a
       *  definite verdict — an unresolvable path, an unreadable tail, an
       *  `indeterminate` classification, or a bounds cutoff. Never folded
       *  into a false "nothing waiting". */
      readonly unreached: number
      readonly scannedAt: string
    }
  | { readonly ok: false; readonly kind: SessionFailureKind; readonly message: string; readonly scannedAt: string }

/** `'relay:copy'`'s response — `main/relay/clipboard.ts`'s `copyRelayReply`
 *  returns exactly this shape, validated main-side before electron's
 *  clipboard is ever touched (`ok: false` for a non-string or over-length
 *  payload) so the renderer's own disabled-button state is never the only
 *  guard. */
export interface RelayCopyResponse {
  readonly ok: boolean
}
