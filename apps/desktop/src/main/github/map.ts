// Nodes → PipelineItem, merging by kind + number and unioning matchedKeys. Never reconstruct a
// label key by comparing strings — matchedKeys comes from the alias table query.ts built.
import type { LabelKey } from '../../shared/labels/vocabulary'
import type { CheckContext, ItemState, Mergeable, PipelineItem, PipelineItemKind, PullRequestCommentNode, QueriedLabel, ReviewNode } from '../../shared/github/types'

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
  readonly headRefOid?: unknown
  readonly mergeable?: unknown
  readonly reviews?: unknown
  readonly comments?: unknown
  readonly commits?: unknown
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

/** Reads `{ nodes: [{ <field>: string }] }`, filtering out non-strings — an unassigned item
 *  legitimately has an empty `assignees.nodes` and must map to `[]`, not be dropped. */
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

/** Maps GitHub's own mergeability enum to `Mergeable` verbatim — anything else reads as `null`. */
function mergeableOf(value: unknown): Mergeable {
  if (value === 'MERGEABLE' || value === 'CONFLICTING' || value === 'UNKNOWN') return value
  return null
}

/** `commit.oid` is flattened to `commitOid` here so nothing downstream reaches into a nested
 *  GraphQL shape. */
function reviewNodesOf(value: unknown): readonly ReviewNode[] {
  const connection = asConnection(value)
  const nodes = connection?.nodes
  if (!Array.isArray(nodes)) return []
  const out: ReviewNode[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    if (typeof raw.body !== 'string' || typeof raw.submittedAt !== 'string') continue
    const commit = typeof raw.commit === 'object' && raw.commit !== null ? (raw.commit as Record<string, unknown>) : undefined
    const commitOid = typeof commit?.oid === 'string' ? commit.oid : null
    out.push({ body: raw.body, submittedAt: raw.submittedAt, commitOid })
  }
  return out
}

/** Reads the `CheckRollupFields` selection. `undefined` — commits was never selected on this
 *  alias — reads as `null`; selected but empty reads as `[]`, never conflated with "not selected". */
function checkRollupOf(node: RawNode): readonly CheckContext[] | null {
  if (!('commits' in node)) return null
  const commits = asConnection(node.commits)
  const commitNodes: readonly unknown[] = Array.isArray(commits?.nodes) ? commits.nodes : []
  const firstCommit = commitNodes[0]
  const commit = typeof firstCommit === 'object' && firstCommit !== null ? (firstCommit as Record<string, unknown>).commit : undefined
  const rollup = typeof commit === 'object' && commit !== null ? (commit as Record<string, unknown>).statusCheckRollup : undefined
  const rollupObj = typeof rollup === 'object' && rollup !== null ? (rollup as Record<string, unknown>) : undefined
  const contexts = asConnection(rollupObj?.contexts)
  const contextNodes = contexts?.nodes
  if (!Array.isArray(contextNodes)) return []
  const out: CheckContext[] = []
  for (const raw of contextNodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    const typename = c.__typename === 'CheckRun' || c.__typename === 'StatusContext' ? c.__typename : null
    out.push({
      __typename: typename,
      name: typeof c.name === 'string' ? c.name : typeof c.context === 'string' ? c.context : null,
      conclusion: typeof c.conclusion === 'string' ? c.conclusion : null,
      status: typeof c.status === 'string' ? c.status : null,
      state: typeof c.state === 'string' ? c.state : null,
      startedAt: typeof c.startedAt === 'string' ? c.startedAt : null,
      completedAt: typeof c.completedAt === 'string' ? c.completedAt : null,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
      url: typeof c.detailsUrl === 'string' ? c.detailsUrl : typeof c.targetUrl === 'string' ? c.targetUrl : null,
    })
  }
  return out
}

/** The `## Gate cleared` carve-out's own evidence, the same shape `reviewNodesOf` establishes. */
function commentNodesOf(value: unknown): readonly PullRequestCommentNode[] {
  const connection = asConnection(value)
  const nodes = connection?.nodes
  if (!Array.isArray(nodes)) return []
  const out: PullRequestCommentNode[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    if (typeof raw.body !== 'string' || typeof raw.createdAt !== 'string') continue
    out.push({ body: raw.body, createdAt: raw.createdAt })
  }
  return out
}

function nodeToItem(node: RawNode, kind: PipelineItemKind, repo: string, key: LabelKey): PipelineItem | undefined {
  const number = numberField(node.number)
  if (number === undefined) return undefined
  const isPullRequest = kind === 'pull-request'
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
    headRefOid: isPullRequest && typeof node.headRefOid === 'string' ? node.headRefOid : null,
    mergeable: isPullRequest ? mergeableOf(node.mergeable) : null,
    reviews: isPullRequest ? reviewNodesOf(node.reviews) : null,
    comments: isPullRequest ? commentNodesOf(node.comments) : null,
    checkRollup: isPullRequest ? checkRollupOf(node) : null,
  }
}

/** Merging by `kind + number` is why an item returned by three aliases appears exactly once,
 *  with the union of their `matchedKeys`. */
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
      // The cross-alias merge keeps whichever copy of checkRollup is non-null.
      if (!existing.matchedKeys.includes(key) || existing.checkRollup === null) {
        merged.set(mapKey, {
          ...existing,
          matchedKeys: existing.matchedKeys.includes(key) ? existing.matchedKeys : [...existing.matchedKeys, key],
          checkRollup: existing.checkRollup ?? item.checkRollup,
        })
      }
    }
  }

  for (const alias of aliases) {
    ingest(alias.issueAlias, 'issue', alias.key)
    ingest(alias.prAlias, 'pull-request', alias.key)
  }

  return [...merged.values()]
}

/** Overlays `fetchItemStates` results onto an already-mapped item list. An item with no matching
 *  state is returned unchanged; a state with no matching item is ignored. */
export function applyItemStates(items: readonly PipelineItem[], states: readonly ItemState[]): readonly PipelineItem[] {
  const byKey = new Map(states.map((state) => [`${state.kind}:${state.number}`, state]))
  return items.map((item) => {
    const state = byKey.get(`${item.kind}:${item.number}`)
    if (!state) return item
    return { ...item, state: state.state, mergedAt: state.mergedAt }
  })
}
