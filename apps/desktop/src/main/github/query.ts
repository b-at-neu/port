// Pure GraphQL document builders — no network, no config read, no `gh`. Two
// decisions from #76's plan are pinned mechanically by
// `scripts/checks/desktop-github.mjs`, so they stay decisions rather than
// prose this file could quietly stop following:
//
// - Decision 1: one alias per (label × surface), never a multi-label
//   `labels:` argument — GitHub's own docs never state whether a multi-name
//   list is AND or OR, so the question is avoided entirely.
// - Decision 2: GraphQL `search` is never used — it is index-backed with
//   ingestion lag, so a label applied seconds ago would not be searchable
//   yet. `repository.issues`/`pullRequests` are read-your-writes consistent.
import type { LabelVocabulary, ResolvedLabel } from '../../shared/labels/vocabulary'
import type { ItemRef, PipelineItemKind, QueriedLabel } from '../../shared/github/types'

const PAGE_SIZE = 100
const REPO_LABEL_PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 20
const ITEM_LABEL_PAGE_SIZE = 20

/**
 * A valid GraphQL StringValue for every escape `JSON.stringify` emits —
 * verified live against a label name containing `"`, `\`, and a newline
 * (`query.test.ts`). Exported so the test can exercise the escaping rule
 * directly rather than re-deriving it from the built document.
 */
export function graphqlStringLiteral(value: string): string {
  return JSON.stringify(value)
}

const ISSUE_FRAGMENT = `fragment IssueFields on Issue {
  number
  title
  url
  body
  state
  assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }
  labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }
}`

const PULL_REQUEST_FRAGMENT = `fragment PullRequestFields on PullRequest {
  number
  title
  url
  body
  state
  mergedAt
  assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }
  labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }
}`

export interface PipelineQuery {
  readonly document: string
  readonly aliases: readonly QueriedLabel[]
}

/**
 * One `issues`/`pullRequests` alias pair per enabled label in
 * `vocabulary.labels` (module-disabled keys are already absent from that
 * array — see `resolveVocabulary`). `<idx>` is the label's position, never
 * derived from the label's own name: an alias must be a valid GraphQL name
 * and a label name is arbitrary operator input. Every connection requests
 * `totalCount` beside `nodes` — the only truncation signal there is.
 */
export function buildPipelineQuery(vocabulary: LabelVocabulary): PipelineQuery {
  const aliases: QueriedLabel[] = []
  const connections: string[] = []

  vocabulary.labels.forEach((label: ResolvedLabel, idx: number) => {
    const issueAlias = `i${idx}`
    const prAlias = `p${idx}`
    const literal = graphqlStringLiteral(label.name)
    connections.push(
      `  ${issueAlias}: issues(states: OPEN, first: ${PAGE_SIZE}, labels: [${literal}]) { totalCount nodes { ...IssueFields } }`,
      `  ${prAlias}: pullRequests(states: OPEN, first: ${PAGE_SIZE}, labels: [${literal}]) { totalCount nodes { ...PullRequestFields } }`,
    )
    aliases.push({ key: label.key, name: label.name, source: label.source, issueAlias, prAlias })
  })

  const document = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    ...connections,
    `    repoLabels: labels(first: ${REPO_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`,
    '  }',
    '  rateLimit { cost remaining resetAt }',
    '}',
    '',
    ISSUE_FRAGMENT,
    '',
    PULL_REQUEST_FRAGMENT,
  ].join('\n')

  return { document, aliases }
}

export interface ItemsByNumberAlias {
  readonly alias: string
  readonly number: number
}

export interface ItemsByNumberQuery {
  readonly document: string
  readonly aliases: readonly ItemsByNumberAlias[]
}

/**
 * One `issueOrPullRequest(number:)` alias per input number (#79 Decision 4) —
 * the kind is genuinely unknown for a number a worktree or an agent record
 * merely names, unlike `buildItemStatesQuery`'s caller-supplied `kind`. Every
 * alias requests `__typename` and selects `mergedAt` only inside the
 * `PullRequest` inline fragment — an `Issue` has no such field, so
 * requesting it unconditionally would be a GraphQL validation error, never a
 * null. A number that resolves to neither comes back as a `null` node, read
 * by the caller as `unavailable`, never inferred. Numbers are embedded as
 * literals exactly as `buildItemStatesQuery` already does, for the same
 * reason: every number here is caller-supplied (already a JS `number`),
 * never untrusted string input requiring escaping.
 */
export function buildItemsByNumberQuery(numbers: readonly number[]): ItemsByNumberQuery {
  const aliases: ItemsByNumberAlias[] = []
  const fields: string[] = []

  numbers.forEach((number, idx) => {
    const alias = `n${idx}`
    const labelsField = `labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`
    fields.push(
      `  ${alias}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number title url state closedAt ${labelsField} } ... on PullRequest { number title url state mergedAt closedAt ${labelsField} } }`,
    )
    aliases.push({ alias, number })
  })

  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '}'].join('\n')

  return { document, aliases }
}

export interface ItemStateAlias {
  readonly alias: string
  readonly kind: PipelineItemKind
  readonly number: number
}

export interface ItemStatesQuery {
  readonly document: string
  readonly aliases: readonly ItemStateAlias[]
}

function itemStateFields(kind: PipelineItemKind): string {
  // Issues carry no `mergedAt` field at all — requesting it on an Issue
  // alias is a GraphQL validation error, not a null.
  return kind === 'pull-request' ? 'number state mergedAt closedAt url' : 'number state closedAt url'
}

/**
 * One aliased `issue(number:)`/`pullRequest(number:)` per input item. The
 * caller supplies `kind` (from the open-sweep result that named it), so no
 * alias here is guaranteed to 404 — a number that has genuinely vanished
 * comes back as a partial error, handled by `envelope.ts` the same way as
 * the open sweep's own partial responses. Numbers are embedded as literals,
 * never interpolated into a shared GraphQL variable — each alias needs a
 * different number, and every number here is caller-supplied (already a JS
 * `number`), never untrusted string input requiring escaping.
 */
export function buildItemStatesQuery(items: readonly ItemRef[]): ItemStatesQuery {
  const aliases: ItemStateAlias[] = []
  const fields: string[] = []

  items.forEach((item, idx) => {
    const alias = `s${idx}`
    const selector = item.kind === 'pull-request' ? 'pullRequest' : 'issue'
    fields.push(`  ${alias}: ${selector}(number: ${item.number}) { ${itemStateFields(item.kind)} }`)
    aliases.push({ alias, kind: item.kind, number: item.number })
  })

  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '}'].join('\n')

  return { document, aliases }
}
