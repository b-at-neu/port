// One `query()` turn, fixed short prompt, `maxTurns: 1`, always with `pathToClaudeCodeExecutable` set so the probe never falls back to the SDK's bundled binary. `ANTHROPIC_API_KEY` is never stripped, only reported.
import type { Platform } from '@/main/platform'
import type { Options } from '@/main/platform/sdk'
import type { ProbeOutcome, RunProbeParams } from '@/types/runtime'
import { classifyProbeFailure } from '@/main/sessions/runtime/classify'

/** Only the fields this probe reads off a result message, so `sdk.test.ts` builds plain fixtures rather than every field of the real `SDKResultMessage` union. */
interface ProbeMessage {
  readonly type: string
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
}

const PROBE_PROMPT = 'Reply with only the word "ok" and stop.'

/** 60s — well above a normal one-turn round trip, but still bounded: a hung
 *  child must resolve to `probe-failed`, never an open await. */
const DEFAULT_PROBE_TIMEOUT_MS = 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resultText(message: ProbeMessage): string {
  if (message.subtype === 'success' && typeof message.result === 'string') return message.result
  return (message.errors ?? []).join('; ')
}

function isProbeMessage(value: unknown): value is ProbeMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

export async function runProbe(ctx: Pick<Platform, 'sdk'>, params: RunProbeParams): Promise<ProbeOutcome> {
  let sdk: Awaited<ReturnType<typeof ctx.sdk.load>>
  try {
    sdk = await ctx.sdk.load()
  } catch (error) {
    const text = messageOf(error)
    return { diagnosis: classifyProbeFailure({ text }), detail: text }
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
      if (isProbeMessage(message) && message.type === 'result') last = message
    }

    if (last === null) {
      const text = 'the probe turn ended with no result message'
      return { diagnosis: classifyProbeFailure({ text }), detail: text }
    }
    if (last.subtype === 'success' && !last.is_error) {
      return { diagnosis: 'verified', detail: null }
    }
    const text = resultText(last)
    return { diagnosis: classifyProbeFailure({ text }), detail: text }
  } catch (error) {
    const text = messageOf(error)
    return { diagnosis: classifyProbeFailure({ text }), detail: text }
  }
}
