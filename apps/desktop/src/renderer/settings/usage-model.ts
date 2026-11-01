// Pure copy for Settings → Usage & storage. An unreadable value reads `—` or `Couldn't read`, never `0`.
import type { SizeRead } from '@/types/settings'
import { formatCost, formatTokens } from '@/utils/hosting/usage'
import type { UsageTotals } from '@/utils/hosting/usage'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${UNITS[unit]}`
}

/** `1.2 GB`, `over 1.2 GB` when the walk was cut short, `Couldn't read` on failure. */
export function sizeText(size: SizeRead): string {
  if (!size.ok) return "Couldn't read"
  return size.truncated ? `over ${formatBytes(size.bytes)}` : formatBytes(size.bytes)
}

/** `$1.23 · 450k tokens`, or `—` for a period with no reading. */
export function usageCell(totals: UsageTotals): string {
  if (totals.costUsd === null && totals.totalTokens === null) return '—'
  return `${formatCost(totals.costUsd)} · ${formatTokens(totals.totalTokens)} tokens`
}

export function usageFootnote(since: string | null): string {
  const from = since !== null ? `, from ${new Date(since).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''
  return `Counts sessions port hosted${from}. Kept for 30 days.`
}
