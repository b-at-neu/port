const MINUTE = 60_000

/** `N minutes/hours/days ago`, spelled out. */
export function relativeTime(idleMs: number): string {
  const seconds = Math.max(0, Math.round(idleMs / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${String(days)} day${days === 1 ? '' : 's'} ago`
}

/** DESIGN §6's compact relative time — `just now`, `12m ago`, `2h ago`, `3d ago`. */
export function formatAgo(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ago`
}

/** `formatAgo` for an ISO timestamp read against `now`. */
export function formatAgoSince(iso: string, now: Date): string {
  return formatAgo(now.getTime() - new Date(iso).getTime())
}

/** `Ns ago`, `Nm ago` or `Nh ago` from a millisecond age; `just now` for a negative or non-numeric one. */
export function formatAgoSeconds(ms: number): string {
  if (Number.isNaN(ms) || ms < 0) return 'just now'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  return `${String(Math.round(minutes / 60))}h ago`
}

/** The locale's clock with a padded hour and minute; the input unchanged when it is not a date. */
export function formatShortTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function exactTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

/** `9:05`: the hour unpadded, the minute padded. */
export function formatHourMinute(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours())}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The locale's clock with a padded hour and minute. */
export function formatShortClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** `Nov 3`. */
export function formatMonthDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function formatTimeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString()
}

/** DESIGN §6's compact duration — `<1m`, `12m`, `1h 4m`, `2d 3h`. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (totalMinutes < 1) return '<1m'
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${String(days)}d ${String(hours)}h`
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`
  return `${String(minutes)}m`
}

/** `14:02` same calendar day, else `Mon 14:02`; always `h23` so a mixed 12-/24-hour rail never reads as two different clocks. */
export function formatClock(iso: string, now: Date): string {
  const started = new Date(iso)
  const sameDay = started.getFullYear() === now.getFullYear() && started.getMonth() === now.getMonth() && started.getDate() === now.getDate()
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(started)
  if (sameDay) return time
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(started)
  return `${weekday} ${time}`
}
