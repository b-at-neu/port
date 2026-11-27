// Pure GraphQL builders for the pull-request half of the board read and the pieces both halves share.
// `search` is never used: it is index-backed and lags.
import type { DisplayVocabulary } from '@/utils/labels/display'
import type { SweepAlias, SweepPage } from '@/types/github'

export const ASSIGNEE_PAGE_SIZE = 20
const PAGE_SIZE = 100
const SWEEP_LABEL_PAGE_SIZE = 100
const LABEL_EVENT_PAGE_SIZE = 20
const INTEGRATION_HISTORY_SIZE = 5

/** A valid GraphQL StringValue for every escape `JSON.stringify` emits. */
export function graphqlStringLiteral(value: string): string {
  return JSON.stringify(value)
}

// Shared by both detail reads — Needs you's newest-first sort key, and the stage-move history
// reconcile.ts resolves into stageHistory.
export const LABEL_EVENTS_FIELD = `timelineItems(last: ${LABEL_EVENT_PAGE_SIZE}, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt actor { login } label { name } } } }`

export const ITEM_SWEEP_FIELDS = `number title url body state updatedAt assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } } labels(first: ${SWEEP_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`

// mergeable is the mergeability precondition mergeabilityRoute reads.
const PULL_REQUEST_SWEEP_FIELDS = `${ITEM_SWEEP_FIELDS} mergedAt headRefOid mergeable`

// reviews/comments page sizes bound the cycle cap and zero-diff gate.
const PULL_REQUEST_DETAIL_FIELDS = `reviews(first: 30) { totalCount nodes { body submittedAt commit { oid } } } comments(last: 20) { totalCount nodes { body createdAt } } ${LABEL_EVENTS_FIELD}`

// The statusCheckRollup selection the approval-withdrawal observation reads. Spread only into
// the detail alias of a pull request at the approved stage.
const CHECK_ROLLUP_FRAGMENT = `fragment CheckRollupFields on PullRequest {
  commits(last: 1) {
    nodes {
      commit {
        statusCheckRollup {
          state
          contexts(first: 50) {
            nodes {
              __typename
              ... on CheckRun { name conclusion status startedAt completedAt detailsUrl }
              ... on StatusContext { context state createdAt targetUrl }
            }
          }
        }
      }
    }
  }
}`

export const FIRST_SWEEP_PAGE: SweepPage = { connection: true, after: null }

/** One aliased read by number, keyed by the document's own `<alias>` and the number it asked about. */
export interface NumberedAlias {
  readonly alias: string
  readonly number: number
}

export interface NumberedQuery {
  readonly document: string
  readonly aliases: readonly NumberedAlias[]
}

/** `repository { <fields> }` plus `rateLimit` on every document, so cost sums across round trips. */
export function repositoryDocument(fields: readonly string[], topLevel: readonly string[] = [], trailer: readonly string[] = []): string {
  return ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '  rateLimit { cost remaining resetAt limit }', ...topLevel, '}', ...trailer].join('\n')
}

/** One connection per surface whatever the label count; `labels:` matches any listed name. */
export function sweepConnection(alias: SweepAlias, vocabulary: DisplayVocabulary, page: SweepPage, fields: string): string {
  const names = vocabulary.labels.map((label) =>graphqlStringLiteral(label.name)).join(', ')
  const cursor = page.after === null ? 'null' : graphqlStringLiteral(page.after)
  return `  ${alias}: ${alias}(states: OPEN, first: ${PAGE_SIZE}, labels: [${names}], after: ${cursor}, orderBy: {field: CREATED_AT, direction: ASC}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} } }`
}

const CONTEXTS_FIELD = `contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status startedAt completedAt detailsUrl } ... on StatusContext { context state createdAt targetUrl } } }`

/** The integration branch's recent commits with their rollups, for the integration-red gate. */
function integrationHistoryField(integration: string): string {
  const ref = `ref(qualifiedName: ${graphqlStringLiteral(`refs/heads/${integration}`)}) { target { ... on Commit { history(first: ${INTEGRATION_HISTORY_SIZE}) { nodes { oid statusCheckRollup { ${CONTEXTS_FIELD} } } } } } }`
  return `    integrationHistory: ${ref}`
}

/** The pull-request sweep page. Only page one carries `integrationHistory`, so the integration-red gate costs no round trip of its own. */
export function buildPullSweepQuery(vocabulary: DisplayVocabulary, page: SweepPage, integration: string): string {
  const first = page.after === null
  return repositoryDocument([...(page.connection ? [sweepConnection('pullRequests', vocabulary, page, PULL_REQUEST_SWEEP_FIELDS)] : []), ...(first ? [integrationHistoryField(integration)] : [])])
}

/** The sweep's own fields for tracked pull requests by number, so one whose labels are gone still reads. `<idx>` is the position in `numbers`. */
export function buildTrackedPullsQuery(numbers: readonly number[]): NumberedQuery {
  const aliases = numbers.map((number, idx) => ({ alias: `t${idx}`, number }))
  return { document: repositoryDocument(aliases.map(({ alias, number }) => `  ${alias}: pullRequest(number: ${number}) { ${PULL_REQUEST_SWEEP_FIELDS} }`)), aliases }
}

/** `rollup` is true only for a pull request at the approved or ready-for-review stage. */
export interface PullDetailRef {
  readonly number: number
  readonly rollup: boolean
}

/** The heavy fields the sweep leaves out, one aliased lookup per pull request — priced per real item, not per page. */
export function buildPullDetailsQuery(refs: readonly PullDetailRef[]): NumberedQuery {
  const aliases = refs.map((ref, idx) => ({ alias: `d${idx}`, number: ref.number }))
  const fields = refs.map((ref, idx) => `  d${idx}: pullRequest(number: ${ref.number}) { ${PULL_REQUEST_DETAIL_FIELDS}${ref.rollup ? ' ...CheckRollupFields' : ''} }`)
  // GraphQL rejects a document declaring a fragment nothing spreads.
  const usesCheckRollup = refs.some((ref) => ref.rollup)
  return { document: repositoryDocument(fields, [], usesCheckRollup ? ['', CHECK_ROLLUP_FRAGMENT] : []), aliases }
}
