// Pure: ownership partition against the viewer, ported verbatim from
// scripts/port-tick/classify.mjs's own `partitionOwnership` — asserted
// against its shared case table (`ownership.test.ts`) and pinned against the
// engine's real behaviour by `scripts/checks/desktop-tick.ts`. Per
// plugins/port/docs/PIPELINE.md → "Multi-operator partitioning": an item
// whose assignees do not include the viewer is never acted on, only
// reported.
export interface OwnershipItem {
  readonly number: number
  readonly assignees: readonly string[]
}

export interface OwnershipPartition<T> {
  readonly mine: readonly T[]
  readonly others: readonly T[]
  readonly unowned: readonly T[]
}

/** Splits `items` into `mine` (acted on), `others` (another operator's —
 *  never acted on), and `unowned` (no assignee — reported, never acted on).
 *  Byte-for-byte the same rule as `classify.mjs`'s own `partitionOwnership`,
 *  adapted only to this app's already-flattened `assignees: string[]` —
 *  `classify.mjs` reads a GraphQL-shaped `assignees.nodes[].login`, the wire
 *  shape `ownership.test.ts` adapts at its edges, never in the decision. */
export function partitionOwnership<T extends OwnershipItem>(items: readonly T[], viewer: string): OwnershipPartition<T> {
  const mine: T[] = []
  const others: T[] = []
  const unowned: T[] = []
  for (const item of items) {
    if (item.assignees.length === 0) unowned.push(item)
    else if (item.assignees.includes(viewer)) mine.push(item)
    else others.push(item)
  }
  return { mine, others, unowned }
}
