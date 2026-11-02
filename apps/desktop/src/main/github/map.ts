// Nodes → PipelineItem. matchedKeys is bucketed here, client-side, against the resolved vocabulary.
import type { LabelKey, LabelVocabulary } from '@/utils/labels/vocabulary'
import type { CheckContext, IssueCommentNode, ItemDetail, ItemState, LabelEventNode, Mergeable, PipelineItem, PipelineItemKind, PullRequestCommentNode, ReviewNode } from '@/types/github'
import { toBlockerRead } from '@/main/github/blockers'

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
  readonly updatedAt?: unknown
  readonly assignees?: unknown
  readonly labels?: unknown
  readonly headRefOid?: unknown
  readonly mergeable?: unknown
  readonly reviews?: unknown
  readonly comments?: unknown
  readonly commits?: unknown
  readonly timelineItems?: unknown
  readonly blockedBy?: unknown
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

/** A node missing `body`, `createdAt` or `url` is dropped, never defaulted. */
function issueCommentsOf(value: unknown): readonly IssueCommentNode[] {
  const nodes = asConnection(value)?.nodes
  if (!Array.isArray(nodes)) return []
  const out: IssueCommentNode[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    if (typeof raw.body !== 'string' || typeof raw.createdAt !== 'string' || typeof raw.url !== 'string') continue
    out.push({ body: raw.body, createdAt: raw.createdAt, url: raw.url })
  }
  return out
}

/** `LabeledEvent` nodes, raw label name unresolved — a node missing `createdAt`/`label.name` is
 *  dropped; a ghost/deleted `actor` reads as `null`, never dropped. Absent `timelineItems` → `[]`. */
function labelEventsOf(value: unknown): readonly LabelEventNode[] {
  const connection = asConnection(value)
  const nodes = connection?.nodes
  if (!Array.isArray(nodes)) return []
  const out: LabelEventNode[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const raw = node as Record<string, unknown>
    if (typeof raw.createdAt !== 'string') continue
    const label = typeof raw.label === 'object' && raw.label !== null ? (raw.label as Record<string, unknown>) : undefined
    const labelName = typeof label?.name === 'string' ? label.name : undefined
    if (labelName === undefined) continue
    const actor = typeof raw.actor === 'object' && raw.actor !== null ? (raw.actor as Record<string, unknown>) : undefined
    const login = typeof actor?.login === 'string' ? actor.login : null
    out.push({ label: labelName, actor: login, at: raw.createdAt })
  }
  return out
}

/** The vocabulary keys, in vocabulary order, whose name matches one of `labels` — case-insensitively, as GitHub's own `labels:` filter does. */
function matchedKeysOf(labels: readonly string[], vocabulary: LabelVocabulary): readonly LabelKey[] {
  const present = new Set(labels.map((label) => label.toLowerCase()))
  return vocabulary.labels.filter((label) => present.has(label.name.toLowerCase())).map((label) => label.key)
}

function nodeToItem(node: RawNode, kind: PipelineItemKind, repo: string, vocabulary: LabelVocabulary): PipelineItem | undefined {
  const number = numberField(node.number)
  if (number === undefined) return undefined
  const labels = fieldListOf(node.labels, 'name')
  const matchedKeys = matchedKeysOf(labels, vocabulary)
  if (matchedKeys.length === 0) return undefined
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
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : null,
    assignees: fieldListOf(node.assignees, 'login'),
    labels,
    matchedKeys,
    labelEvents: [],
    headRefOid: isPullRequest && typeof node.headRefOid === 'string' ? node.headRefOid : null,
    mergeable: isPullRequest ? mergeableOf(node.mergeable) : null,
    reviews: isPullRequest ? [] : null,
    comments: isPullRequest ? [] : null,
    checkRollup: null,
    blockers: null,
    blockerComments: null,
  }
}

/** Sweep nodes of one surface → light items; an item seen on two pages is kept once, and a node
 *  matching no vocabulary label is dropped. */
export function mapPipelineItems(nodes: readonly unknown[], kind: PipelineItemKind, vocabulary: LabelVocabulary, repo: string): readonly PipelineItem[] {
  const byNumber = new Map<number, PipelineItem>()
  for (const raw of nodes) {
    if (!isRawNode(raw)) continue
    const item = nodeToItem(raw, kind, repo, vocabulary)
    if (item) byNumber.set(item.number, item)
  }
  return [...byNumber.values()]
}

/** Overlays the detail read onto the swept items. An item with no detail keeps its placeholders —
 *  `fetchPipelineItems` fails the whole read before that can reach a caller. */
export function applyItemDetails(items: readonly PipelineItem[], details: readonly ItemDetail[]): readonly PipelineItem[] {
  const byKey = new Map(details.map((detail) => [`${detail.kind}:${detail.number}`, detail]))
  return items.map((item) => {
    const detail = byKey.get(`${item.kind}:${item.number}`)
    const node = detail?.node
    if (detail === undefined || !isRawNode(node)) return item
    const isPullRequest = item.kind === 'pull-request'
    const commentsRead = !isPullRequest && 'comments' in node && !detail.erroredFields.includes('comments')
    return {
      ...item,
      labelEvents: labelEventsOf(node.timelineItems),
      reviews: isPullRequest ? reviewNodesOf(node.reviews) : null,
      comments: isPullRequest ? commentNodesOf(node.comments) : null,
      checkRollup: isPullRequest ? checkRollupOf(node) : null,
      blockers: isPullRequest ? null : toBlockerRead(node.blockedBy, detail.erroredFields.includes('blockedBy')),
      blockerComments: commentsRead ? issueCommentsOf(node.comments) : null,
    }
  })
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
