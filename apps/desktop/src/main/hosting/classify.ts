// #98: `classifyEnd` over the four wordings the SDK actually emits for a
// terminal transport-level failure, each its own reason, driven by the
// authoritative decision-case table (`classify.cases.json`, pinned by
// `desktop-hosting.ts` per ENGINEERING §2) — no I/O here.
//
// Unrecognised text is `stream-error` with the message carried verbatim,
// never a guessed reason: these four strings are the SDK's, not a contract
// it owes us, so a version bump that rewords one must degrade to "ended,
// here is exactly what it said" rather than mis-attributing a crash to a
// clean exit (same direction as #97's `probe-failed`).
import type { CredentialsTell, RuntimeDiagnosis } from '../../shared/runtime/types'
import type { SessionEndReason } from '../../shared/hosting/types'
import { classifyProbeFailure } from '../runtime/classify'

/** The CLI's own deterministic refusal of a `resumeDropsTurn` fork point —
 *  checked first because its message also contains ordinary prose, never a
 *  substring the other four wordings could produce. */
const RESUME_REJECTED_PREFIX = 'Resume rejected by --resume-drops-turn:'

const EXIT_NONZERO_RE = /Claude Code process exited with code (-?\d+)/
const SIGNAL_RE = /terminated by signal (\S+)/
const PROCESS_ERROR_RE = /process error:/i
const ABORTED_RE = /aborted by user/i

export interface ClassifyEndInput {
  readonly text: string
  /** Whether this handle's own `close()` requested the abort — distinguishes
   *  a graceful stop (`closed`) from an abort this app never asked for
   *  (`stream-error`) when the SDK's own wording is otherwise identical. */
  readonly closeRequested: boolean
  readonly credentials: CredentialsTell | null
  readonly now: number
}

export interface ClassifyEndResult {
  readonly reason: SessionEndReason
  readonly exitCode: number | null
  readonly signal: string | null
  /** `classifyProbeFailure`'s own verdict over `text` — one failure
   *  vocabulary, not a second one at the lifecycle call site. `null` for the
   *  reasons that are not failures. */
  readonly diagnosis: RuntimeDiagnosis | null
}

function diagnose(input: ClassifyEndInput): RuntimeDiagnosis {
  return classifyProbeFailure({ text: input.text, credentials: input.credentials, now: input.now })
}

export function classifyEnd(input: ClassifyEndInput): ClassifyEndResult {
  if (input.text.startsWith(RESUME_REJECTED_PREFIX)) {
    return { reason: 'resume-rejected', exitCode: null, signal: null, diagnosis: null }
  }

  // The one required capture group is always present when `exec` matches at
  // all — `noUncheckedIndexedAccess` still types the array element access as
  // possibly `undefined`, so the guard below is what actually narrows it.
  const exitCodeText = EXIT_NONZERO_RE.exec(input.text)?.[1]
  if (exitCodeText !== undefined) {
    return { reason: 'exit-nonzero', exitCode: Number(exitCodeText), signal: null, diagnosis: diagnose(input) }
  }

  const signalText = SIGNAL_RE.exec(input.text)?.[1]
  if (signalText !== undefined) {
    return { reason: 'signal', exitCode: null, signal: signalText, diagnosis: diagnose(input) }
  }

  if (PROCESS_ERROR_RE.test(input.text)) {
    return { reason: 'process-error', exitCode: null, signal: null, diagnosis: diagnose(input) }
  }

  if (ABORTED_RE.test(input.text)) {
    return input.closeRequested
      ? { reason: 'closed', exitCode: null, signal: null, diagnosis: null }
      : { reason: 'stream-error', exitCode: null, signal: null, diagnosis: diagnose(input) }
  }

  return { reason: 'stream-error', exitCode: null, signal: null, diagnosis: diagnose(input) }
}
