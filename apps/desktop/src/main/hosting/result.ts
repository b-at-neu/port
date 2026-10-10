// A structural read of the SDK's final `result` message — narrows without a type import from the SDK's own result union, the same rule `readRateLimit`/`readUsage` already follow.
import type { SDKMessage } from './sdk'
import type { SessionResult } from '../../shared/hosting/stage'
import { SESSION_RESULT_TEXT_CAP } from '../../shared/hosting/stage'

/** `message.type === 'result'` only — anything else is `null`, never guessed. `result` is read only when it is a string; a missing or non-string field leaves `text` `null` rather than coercing. */
export function readResult(message: SDKMessage, at: string): SessionResult | null {
  if (message.type !== 'result') return null
  const raw = message as { subtype: string; is_error: boolean; result?: unknown }
  const text = typeof raw.result === 'string' ? raw.result : null
  return {
    subtype: raw.subtype,
    isError: raw.is_error,
    text: text === null ? null : text.length > SESSION_RESULT_TEXT_CAP ? text.slice(text.length - SESSION_RESULT_TEXT_CAP) : text,
    at,
  }
}
