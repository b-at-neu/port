// Pure: the bounded facts an incident carries. Typed fields only — never a body, a comment or transcript text.
import { verdictOf } from '@/main/pipeline/tick/adopt'
import { INCIDENT_INPUTS_MAX_BYTES, type IncidentInputs } from '@/types/incidents'
import type { ReconciledItem } from '@/types/state'

const encoder = new TextEncoder()

function bytesOf(inputs: IncidentInputs): number {
  return encoder.encode(JSON.stringify(inputs)).length
}

function longestArrayKey(inputs: IncidentInputs): string | null {
  let best: string | null = null
  let bestLength = 0
  for (const [key, value] of Object.entries(inputs)) {
    if (Array.isArray(value) && value.length > bestLength) {
      best = key
      bestLength = value.length
    }
  }
  return best
}

/** Over the cap, drops the tail of the longest list and says how many went; the last resort keeps only the size, so the cap always holds. */
export function boundInputs(inputs: IncidentInputs): IncidentInputs {
  let current: Record<string, unknown> = { ...inputs }
  const dropped = new Map<string, number>()
  for (;;) {
    const size = bytesOf(current)
    if (size <= INCIDENT_INPUTS_MAX_BYTES) return current
    const key = longestArrayKey(current)
    const list: unknown = key === null ? undefined : current[key]
    if (key === null || !Array.isArray(list) || list.length === 0) return { truncated: true, bytes: size }
    const kept: readonly unknown[] = (list as readonly unknown[]).filter((entry) => !(typeof entry === 'object' && entry !== null && 'dropped' in entry))
    if (kept.length === 0) return { truncated: true, bytes: size }
    const keep = Math.floor(kept.length / 2)
    dropped.set(key, (dropped.get(key) ?? 0) + kept.length - keep)
    current = { ...current, [key]: [...kept.slice(0, keep), { dropped: dropped.get(key) }] }
  }
}

function claimOf(item: ReconciledItem): { readonly key: string; readonly at: string } | null {
  const [stage] = item.stages
  if (stage === undefined) return null
  const entry = item.stageHistory.findLast((candidate) => candidate.key === stage.key)
  return entry === undefined ? null : { key: entry.key, at: entry.at }
}

/** The allowed fields of one reconciled item. */
export function itemInputs(item: ReconciledItem): Record<string, unknown> {
  return {
    labels: item.stages.map((stage) => stage.key),
    assignees: item.assignees,
    headRefOid: item.headRefOid,
    claim: claimOf(item),
    workSessions: item.workSessions.map((session) => session.sessionId),
    reviews: (item.reviews ?? []).map((review) => ({ id: review.submittedAt, verdict: verdictOf(review), commitOid: review.commitOid })),
    checks: (item.checkRollup ?? []).map((check) => ({ name: check.name, state: check.conclusion ?? check.state ?? check.status })),
    closingPullRequests: (item.closingPullRequests ?? []).map((pr) => ({ number: pr.number, state: pr.state })),
  }
}
