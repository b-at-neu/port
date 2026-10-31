// Renderer-safe usage contract: aggregation and formatting over readings the main process already
// put on each snapshot. Pure throughout — no SDK import, no I/O.

/** One handle's cumulative usage reading, since port opened it — `null` fields mean unread, never zero. */
export interface SessionUsage {
  readonly costUsd: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly cacheReadTokens: number | null
  readonly cacheWriteTokens: number | null
  readonly contextTokens: number | null
  readonly contextWindow: number | null
  readonly observedAt: string
}

export interface UsageTotals {
  readonly costUsd: number | null
  readonly totalTokens: number | null
  readonly sessions: number
}

/** Sums only the snapshots carrying a non-null `usage`; `sessions` counts just those. With no readings at all, both totals are `null`, never `0`. */
export function aggregateUsage(usages: ReadonlyArray<SessionUsage | null>): UsageTotals {
  let costUsd: number | null = null
  let totalTokens: number | null = null
  let sessions = 0

  for (const usage of usages) {
    if (usage === null) continue
    sessions += 1
    if (usage.costUsd !== null) costUsd = (costUsd ?? 0) + usage.costUsd
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (usage.inputTokens !== null || usage.outputTokens !== null || usage.cacheReadTokens !== null || usage.cacheWriteTokens !== null) {
      totalTokens = (totalTokens ?? 0) + tokens
    }
  }

  return { costUsd, totalTokens, sessions }
}

/** Integer 0–100, clamped, or `null` when either side is unknown or the window is not positive. */
export function contextPercent(usage: SessionUsage | null): number | null {
  if (usage === null) return null
  const { contextTokens, contextWindow } = usage
  if (contextTokens === null || contextWindow === null || contextWindow <= 0) return null
  const percent = Math.round((contextTokens / contextWindow) * 100)
  return Math.min(100, Math.max(0, percent))
}

/** `$0.92`-shaped (DESIGN §6); a positive value under a cent reads as `<$0.01` rather than `$0.00`. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return '—'
  if (costUsd > 0 && costUsd < 0.01) return '<$0.01'
  return `$${costUsd.toFixed(2)}`
}

/** `950`, `12.3k`, `1.2M` — one decimal place above 1,000, trimmed when it is `.0`. */
export function formatTokens(tokens: number | null): string {
  if (tokens === null) return '—'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${trimZero((tokens / 1000).toFixed(1))}k`
  return `${trimZero((tokens / 1_000_000).toFixed(1))}M`
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value
}
