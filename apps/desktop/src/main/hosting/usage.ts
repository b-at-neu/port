// Narrows assistant/result messages structurally rather than importing the SDK's own event types,
// the same rule as rate-limit.ts. Figures are cumulative for this claude process; a resumed session
// starts from its own result, so the totals mean "since port opened it."
import type { SessionUsage } from '../../shared/hosting/usage'

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sumField(modelUsage: Record<string, unknown>, field: string): number | null {
  let total: number | null = null
  for (const entry of Object.values(modelUsage)) {
    if (typeof entry !== 'object' || entry === null) continue
    const value = numberOrNull((entry as Record<string, unknown>)[field])
    if (value !== null) total = (total ?? 0) + value
  }
  return total
}

function contextWindowFor(modelUsage: Record<string, unknown>, model: string | null): number | null {
  if (model === null) return null
  const entry = modelUsage[model]
  if (typeof entry !== 'object' || entry === null) return null
  return numberOrNull((entry as Record<string, unknown>).contextWindow)
}

/** `previous` carries the last-seen model (for `contextWindow` lookup on the next `result`) alongside the reading itself. */
export interface UsageReading {
  readonly usage: SessionUsage
  readonly model: string | null
}

/** Anything that is not a top-level `assistant`/`result` message, a subagent turn (`parent_tool_use_id` non-null),
 *  or carries no usable numbers, returns `previous` unchanged — a malformed number never overwrites a good reading. */
export function readUsage(message: unknown, previous: UsageReading | null, observedAt: string): UsageReading | null {
  if (typeof message !== 'object' || message === null) return previous
  const envelope = message as Record<string, unknown>

  if (envelope.type === 'assistant') {
    if (envelope.parent_tool_use_id !== null && envelope.parent_tool_use_id !== undefined) return previous
    const inner = envelope.message
    if (typeof inner !== 'object' || inner === null) return previous
    const innerRecord = inner as Record<string, unknown>
    const usageField = innerRecord.usage
    if (typeof usageField !== 'object' || usageField === null) return previous
    const usageRecord = usageField as Record<string, unknown>
    const inputTokens = numberOrNull(usageRecord.input_tokens)
    const cacheCreation = numberOrNull(usageRecord.cache_creation_input_tokens) ?? 0
    const cacheRead = numberOrNull(usageRecord.cache_read_input_tokens) ?? 0
    if (inputTokens === null) return previous
    const contextTokens = inputTokens + cacheCreation + cacheRead
    const model = typeof innerRecord.model === 'string' ? innerRecord.model : (previous?.model ?? null)
    return {
      model,
      usage: {
        costUsd: previous?.usage.costUsd ?? null,
        inputTokens: previous?.usage.inputTokens ?? null,
        outputTokens: previous?.usage.outputTokens ?? null,
        cacheReadTokens: previous?.usage.cacheReadTokens ?? null,
        cacheWriteTokens: previous?.usage.cacheWriteTokens ?? null,
        contextWindow: previous?.usage.contextWindow ?? null,
        contextTokens,
        observedAt,
      },
    }
  }

  if (envelope.type === 'result') {
    const costUsd = numberOrNull(envelope.total_cost_usd)
    const modelUsageField = envelope.modelUsage
    const modelUsage = typeof modelUsageField === 'object' && modelUsageField !== null ? (modelUsageField as Record<string, unknown>) : null
    if (costUsd === null && modelUsage === null) return previous
    const inputTokens = modelUsage !== null ? sumField(modelUsage, 'inputTokens') : null
    const outputTokens = modelUsage !== null ? sumField(modelUsage, 'outputTokens') : null
    const cacheReadTokens = modelUsage !== null ? sumField(modelUsage, 'cacheReadInputTokens') : null
    const cacheWriteTokens = modelUsage !== null ? sumField(modelUsage, 'cacheCreationInputTokens') : null
    const contextWindow = modelUsage !== null ? contextWindowFor(modelUsage, previous?.model ?? null) : null
    return {
      model: previous?.model ?? null,
      usage: {
        costUsd: costUsd ?? previous?.usage.costUsd ?? null,
        inputTokens: inputTokens ?? previous?.usage.inputTokens ?? null,
        outputTokens: outputTokens ?? previous?.usage.outputTokens ?? null,
        cacheReadTokens: cacheReadTokens ?? previous?.usage.cacheReadTokens ?? null,
        cacheWriteTokens: cacheWriteTokens ?? previous?.usage.cacheWriteTokens ?? null,
        contextTokens: previous?.usage.contextTokens ?? null,
        contextWindow: contextWindow ?? previous?.usage.contextWindow ?? null,
        observedAt,
      },
    }
  }

  return previous
}
