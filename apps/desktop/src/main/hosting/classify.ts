// Unrecognised text is `stream-error` with the message carried verbatim, never a guessed reason.
import type { CredentialsTell, RuntimeDiagnosis } from '../../shared/runtime/types'
import type { SessionEndReason } from '../../shared/hosting/types'
import { classifyProbeFailure } from '../runtime/classify'

/** The CLI's own refusal of a `resumeDropsTurn` fork point; checked first since its message also contains ordinary prose. */
const RESUME_REJECTED_PREFIX = 'Resume rejected by --resume-drops-turn:'

const EXIT_NONZERO_RE = /Claude Code process exited with code (-?\d+)/
const SIGNAL_RE = /terminated by signal (\S+)/
const PROCESS_ERROR_RE = /process error:/i
const ABORTED_RE = /aborted by user/i

export interface ClassifyEndInput {
  readonly text: string
  /** Whether this handle's own `close()` requested the abort, distinguishing a graceful stop from an unrequested one. */
  readonly closeRequested: boolean
  readonly credentials: CredentialsTell | null
  readonly now: number
}

export interface ClassifyEndResult {
  readonly reason: SessionEndReason
  readonly exitCode: number | null
  readonly signal: string | null
  readonly diagnosis: RuntimeDiagnosis | null
}

function diagnose(input: ClassifyEndInput): RuntimeDiagnosis {
  return classifyProbeFailure({ text: input.text, credentials: input.credentials, now: input.now })
}

export function classifyEnd(input: ClassifyEndInput): ClassifyEndResult {
  if (input.text.startsWith(RESUME_REJECTED_PREFIX)) {
    return { reason: 'resume-rejected', exitCode: null, signal: null, diagnosis: null }
  }

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
