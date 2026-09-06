// Nodes → `PipelineItem`, merging by `kind + number` and unioning
// `matchedKeys`. Never reconstruct a label key by comparing strings — every
// item's `matchedKeys` comes from the alias table `query.ts` built, not from
// re-matching `labels` against the vocabulary.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { ItemState, PipelineItem, PipelineItemKind, QueriedLabel } from '../../shared/github/types'

interface ConnectionLike {
  readonly totalCount?: unknown
  readonly nodes?: unknown
}

function asConnection(value: unknown): ConnectionLike | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

interface RawNode {
  readonly number?: unknown
  readonly title?: unknown
  readonly url?: unknown
  readonly body?: unknown
  readonly state?: unknown
  readonly mergedAt?: unknown
  readonly assignees?: unknown
  readonly labels?: unknown
}

function isRawNode(value: unknown): value is RawNode {
  return typeof value === 'object' && value !== null
}

function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/** Reads `{ nodes: [{ <field>: string }] }`, filtering out anything that
 *  isn't a string — an unassigned item legitimately has an empty
 *  `assignees.nodes` and must map to `[]`, not be dropped. Exported so
 *  `fetchItemsByNumber` (`adapter.ts`) reads `ResolvedItem.labels` the same
 *  way, rather than a second ad hoc reader. */
export function fieldListOf(value: unknown, field: 'login' | 'name'): readonly string[] {
  const connection = asConnection(value)
  const nodes = connection?.nodes
  if (!Array.isArray(nodes)) return []
  const out: string[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = (node as Record<string, unknown>)[field]
    if (typeof raw === 'string') out.push(raw)
  }
  return out
}

function nodeToItem(node: RawNode, kind: PipelineItemKind, repo: string, key: LabelKey): PipelineItem | undefined {
  const number = numberField(node.number)
  if (number === undefined) return undefined
  return {
    repo,
    kind,
    number,
    title: stringField(node.title),
    url: stringField(node.url),
    body: stringField(node.body),
    state: stringField(node.state),
    mergedAt: typeof node.mergedAt === 'string' ? node.mergedAt : null,
    assignees: fieldListOf(node.assignees, 'login'),
    labels: fieldListOf(node.labels, 'name'),
    matchedKeys: [key],
  }
}

/**
 * `repository` is the envelope's `data.repository` object; `aliases` is the
 * table `buildPipelineQuery` returned alongside the document it built.
 * Merging by `kind + number` is why an item returned by three aliases (three
 * pipeline labels at once) appears exactly once, with the union of the three
 * `matchedKeys`.
 */
export function mapPipelineItems(repository: Readonly<Record<string, unknown>>, aliases: readonly QueriedLabel[], repo: string): readonly PipelineItem[] {
  const merged = new Map<string, PipelineItem>()

  function ingest(aliasName: string, kind: PipelineItemKind, key: LabelKey): void {
    const connection = asConnection(repository[aliasName])
    const nodes = connection?.nodes
    if (!Array.isArray(nodes)) return
    for (const raw of nodes) {
      if (!isRawNode(raw)) continue
      const item = nodeToItem(raw, kind, repo, key)
      if (!item) continue
      const mapKey = `${kind}:${item.number}`
      const existing = merged.get(mapKey)
      if (!existing) {
        merged.set(mapKey, item)
        continue
      }
      if (!existing.matchedKeys.includes(key)) {
        merged.set(mapKey, { ...existing, matchedKeys: [...existing.matchedKeys, key] })
      }
    }
  }

  for (const alias of aliases) {
    ingest(alias.issueAlias, 'issue', alias.key)
    ingest(alias.prAlias, 'pull-request', alias.key)
  }

  return [...merged.values()]
}

/** Overlays `fetchItemStates` results onto an already-mapped item list —
 *  `state`/`mergedAt` are constant (`OPEN`/`null`) on the open-only sweep, so
 *  this is the only place either field changes. An item with no matching
 *  state is returned unchanged; a state with no matching item is ignored
 *  (the caller reports it via `unavailable` instead). */
export function applyItemStates(items: readonly PipelineItem[], states: readonly ItemState[]): readonly PipelineItem[] {
  const byKey = new Map(states.map((state) => [`${state.kind}:${state.number}`, state]))
  return items.map((item) => {
    const state = byKey.get(`${item.kind}:${item.number}`)
    if (!state) return item
    return { ...item, state: state.state, mergedAt: state.mergedAt }
  })
}
