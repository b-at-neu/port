// Pure formatting helpers for the shell (#316). No runtime imports — kept
// trivially unit-testable and safe for anything to import.

/** DESIGN §6's relative-time format: "just now" under a minute, then
 *  `<n>m ago` / `<n>h ago` / `<n>d ago`. The caller supplies `now` so this
 *  stays pure and testable against a fixed clock. */
export function relativeAge(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  const diffMs = now.getTime() - then
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
