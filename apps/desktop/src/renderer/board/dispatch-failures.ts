import type { DispatchRecord } from '@/types/dispatch'

export interface FailingDispatch {
  readonly record: DispatchRecord
  readonly attempts: number
}

/** One entry per (agent, number) whose newest record is a failure; a later `started` or `ended` record clears it. */
export function failingDispatches(recent: readonly DispatchRecord[]): readonly FailingDispatch[] {
  const groups = new Map<string, DispatchRecord[]>()
  for (const record of recent) {
    const key = `${record.agent}:${String(record.number)}`
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const failing: FailingDispatch[] = []
  for (const records of groups.values()) {
    const ordered = records.map((record, index) => ({ record, index })).sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at) || a.index - b.index)
    const newest = ordered[ordered.length - 1]?.record
    if (newest?.state !== 'failed') continue
    const tail = ordered.map((entry) => entry.record).reverse()
    const firstOther = tail.findIndex((record) => record.state !== 'failed')
    failing.push({ record: newest, attempts: firstOther === -1 ? tail.length : firstOther })
  }
  return failing
}

/** The repository's newest record overall, only when it is a failure. */
export function lastLaunchFailed(recent: readonly DispatchRecord[]): DispatchRecord | null {
  let newest: DispatchRecord | null = null
  for (const record of recent) {
    if (newest === null || Date.parse(record.at) >= Date.parse(newest.at)) newest = record
  }
  return newest?.state === 'failed' ? newest : null
}
