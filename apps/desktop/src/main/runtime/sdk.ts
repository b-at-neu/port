// One `query()` turn, fixed short prompt, `maxTurns: 1`, always with `pathToClaudeCodeExecutable` set so the probe never falls back to the SDK's bundled binary. `ANTHROPIC_API_KEY` is never stripped, only reported.
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { CredentialsTell, RuntimeDiagnosis } from '../../shared/runtime/types'
import { classifyProbeFailure } from './classify'

/** Only the fields this probe reads off a result message, so `sdk.test.ts` builds plain fixtures rather than every field of the real `SDKResultMessage` union. */
interface ProbeMessage {
  readonly type: string
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
}

type SdkQuery = (params: { prompt: string; options?: Options }) => AsyncIterable<ProbeMessage>

const PROBE_PROMPT = 'Reply with only the word "ok" and stop.'

/** 60s — well above a normal one-turn round trip, but still bounded: a hung
 *  child must resolve to `probe-failed`, never an open await. */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RunProbeParams {
  readonly executablePath: string
  readonly cwd: string
  readonly credentials: CredentialsTell | null
  readonly now: number
  readonly timeoutMs?: number
}

export interface ProbeOutcome {
  readonly diagnosis: RuntimeDiagnosis
  readonly detail: string | null
}

export type RuntimeProbeFn = (params: RunProbeParams) => Promise<ProbeOutcome>

function resultText(message: ProbeMessage): string {
  if (message.subtype === 'success' && typeof message.result === 'string') return message.result
  return (message.errors ?? []).join('; ')
}

/** A factory, not a bare export, so a test can inject a fake `importSdk`; the default is a lazy dynamic `import()`, never at module load. */
export function createRuntimeProbe(importSdk: () => Promise<{ query: SdkQuery }> = () => import('@anthropic-ai/claude-agent-sdk')): RuntimeProbeFn {
  return async (params) => {
    let sdk: { query: SdkQuery }
    try {
      sdk = await importSdk()
    } catch (error) {
      const text = messageOf(error)
      return { diagnosis: classifyProbeFailure({ text, credentials: params.credentials, now: params.now }), detail: text }
    }

    const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    // A runtime-native deadline via `AbortSignal`, never a manually scheduled callback — `watcher.ts` is the only file allowed to name a timer. No manual abort call is needed either.
    const abortController: NonNullable<Options['abortController']> = { signal: AbortSignal.timeout(timeoutMs), abort: () => undefined }

    try {
      const stream = sdk.query({
        prompt: PROBE_PROMPT,
        options: { cwd: params.cwd, pathToClaudeCodeExecutable: params.executablePath, maxTurns: 1, abortController },
      })

      let last: ProbeMessage | null = null
      for await (const message of stream) {
        if (message.type === 'result') last = message
      }

      if (last === null) {
        const text = 'the probe turn ended with no result message'
        return { diagnosis: classifyProbeFailure({ text, credentials: params.credentials, now: params.now }), detail: text }
      }
      if (last.subtype === 'success' && !last.is_error) {
        return { diagnosis: 'verified', detail: null }
      }
      const text = resultText(last)
      return { diagnosis: classifyProbeFailure({ text, credentials: params.credentials, now: params.now }), detail: text }
    } catch (error) {
      const text = messageOf(error)
      return { diagnosis: classifyProbeFailure({ text, credentials: params.credentials, now: params.now }), detail: text }
    }
  }
}
