// Needs you's grouped list: one group per kind, ordered by each group's newest item.
import type { NeedsYouGroupKey, NeedsYouItem } from '@/types/board'
import { GROUP_NAMES } from '@/renderer/needs-you/copy'

// Exhaustive over every kind: a new kind is a compile error, never an ungrouped row.
const GROUP_OF: Readonly<Record<NeedsYouItem['kind'], NeedsYouGroupKey>> = {
  'plan-review': 'plan-review',
  'ready-to-merge': 'ready-to-merge',
  'needs-human': 'needs-human',
  blocked: 'blocked',
  'stage-blocked': 'blocked',
  'stage-question': 'questions',
  'stage-questions': 'questions',
  'stage-approval': 'approvals',
  'stage-denial': 'denied',
  'stage-interrupted': 'interrupted',
  'usage-limit': 'usage-limit',
  held: 'held',
  stalled: 'stalled',
  budget: 'budget',
  'half-labelled': 'half-labelled',
}

export interface NeedsYouGroup {
  readonly key: NeedsYouGroupKey
  readonly name: string
  readonly items: readonly NeedsYouItem[]
}

/** `groupNeedsYou(items)` — `items` arrive newest first, so each group's position is its newest item's and rows keep their order. */
export function groupNeedsYou(items: readonly NeedsYouItem[]): readonly NeedsYouGroup[] {
  const byKey = new Map<NeedsYouGroupKey, NeedsYouItem[]>()
  for (const item of items) {
    const key = GROUP_OF[item.kind]
    const members = byKey.get(key)
    if (members === undefined) byKey.set(key, [item])
    else members.push(item)
  }
  return [...byKey].map(([key, members]) => ({ key, name: GROUP_NAMES[key], items: members }))
}
