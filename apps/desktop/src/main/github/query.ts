// Pure GraphQL document builders for the pull-request side — no network, no config read, no gh. GraphQL `search` is never
// used since it is index-backed with ingestion lag. The issue side lives in `tracker/query.ts`.
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { ItemRef, SweepCursor } from '@/types/github'

const PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 20
const SWEEP_LABEL_PAGE_SIZE = 100
const LABEL_EVENT_PAGE_SIZE = 20

/** A valid GraphQL StringValue for every escape `JSON.stringify` emits. */
export function graphqlStringLiteral(value: string): string {
  return JSON.stringify(value)
}

// Shared by both fragments — Needs you's newest-first sort key, and the stage-move history
// reconcile.ts resolves into stageHistory.
export const LABEL_EVENTS_FIELD = `timelineItems(last: ${LABEL_EVENT_PAGE_SIZE}, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt actor { login } label { name } } } }`

/** The light fields every swept item carries; a pull request extends them. */
export const ITEM_SWEEP_FIELDS = `number title url body state updatedAt assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } } labels(first: ${SWEEP_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`

// mergeable is the mergeability precondition mergeabilityRoute reads.
const PULL_REQUEST_SWEEP_FIELDS = `${ITEM_SWEEP_FIELDS} mergedAt headRefOid mergeable`

// reviews/comments page sizes match scripts/port-tick/query.ts's own bound, for the cycle cap
// and zero-diff gate.
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

/** One sweep connection, aliased as itself; `labels:` matches any listed name. */
export function sweepConnection(field: 'issues' | 'pullRequests', names: string, after: SweepCursor, fields: string): string {
  const cursor = after === null ? 'null' : graphqlStringLiteral(after)
  return `  ${field}: ${field}(states: OPEN, first: ${PAGE_SIZE}, labels: [${names}], after: ${cursor}, orderBy: {field: CREATED_AT, direction: ASC}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} } }`
}

const INTEGRATION_HISTORY_SIZE = 5

/** The integration branch's recent commits with their rollups — the same selection `scripts/port-tick/query.ts` reads, for the integration-red gate. */
function integrationHistoryField(integration: string): string {
  const contexts = `contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status startedAt completedAt detailsUrl } ... on StatusContext { context state createdAt targetUrl } } }`
  const ref = `ref(qualifiedName: ${graphqlStringLiteral(`refs/heads/${integration}`)}) { target { ... on Commit { history(first: ${INTEGRATION_HISTORY_SIZE}) { nodes { oid statusCheckRollup { ${contexts} } } } } } }`
  return `    integrationHistory: ${ref}`
}

/** One connection whatever the label count. Only page one carries `integrationHistory` (so its cost rides the sweep), and `rateLimit` rides every page so cost sums.
 *  An empty `labels:` list filters nothing, so with no enabled label the connection is not asked at all and page one still runs. */
export function buildPullRequestSweepQuery(vocabulary: LabelVocabulary, after: SweepCursor, integration: string): string {
  const names = vocabulary.labels.map((label) => graphqlStringLiteral(label.name)).join(', ')
  const repositoryFields = [
    ...(vocabulary.labels.length > 0 ? [sweepConnection('pullRequests', names, after, PULL_REQUEST_SWEEP_FIELDS)] : []),
    ...(after === null ? [integrationHistoryField(integration)] : []),
  ]
  return ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...repositoryFields, '  }', '  rateLimit { cost remaining resetAt limit }', '}'].join('\n')
}

interface TrackedPullRequestsAlias {
  readonly alias: string
  readonly number: number
}

interface TrackedPullRequestsQuery {
  readonly document: string
  readonly aliases: readonly TrackedPullRequestsAlias[]
}

/** The sweep's own fields for tracked pull requests by number, so one whose labels are gone still reads. `<idx>` is the position. */
export function buildTrackedPullRequestsQuery(refs: readonly ItemRef[]): TrackedPullRequestsQuery {
  const aliases: TrackedPullRequestsAlias[] = []
  const fields: string[] = []
  refs.forEach((ref, idx) => {
    const alias = `t${idx}`
    fields.push(`  ${alias}: pullRequest(number: ${ref.number}) { ${PULL_REQUEST_SWEEP_FIELDS} }`)
    aliases.push({ alias, number: ref.number })
  })
  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '  rateLimit { cost remaining resetAt limit }', '}'].join('\n')
  return { document, aliases }
}

/** `rollup` is true only for a pull request at the approved or ready-for-review stage. */
export interface PullRequestDetailRef {
  readonly number: number
  readonly rollup: boolean
}

interface PullRequestDetailAlias extends PullRequestDetailRef {
  readonly alias: string
}

interface PullRequestDetailsQuery {
  readonly document: string
  readonly aliases: readonly PullRequestDetailAlias[]
}

/** The heavy fields the sweep leaves out, one aliased lookup per pull request — priced per real item, not per page. */
export function buildPullRequestDetailsQuery(refs: readonly PullRequestDetailRef[]): PullRequestDetailsQuery {
  const aliases: PullRequestDetailAlias[] = []
  const fields: string[] = []

  refs.forEach((ref, idx) => {
    const alias = `d${idx}`
    const rollup = ref.rollup ? ' ...CheckRollupFields' : ''
    fields.push(`  ${alias}: pullRequest(number: ${ref.number}) { ${PULL_REQUEST_DETAIL_FIELDS}${rollup} }`)
    aliases.push({ ...ref, alias })
  })

  // GraphQL rejects a document declaring a fragment nothing spreads.
  const usesCheckRollup = refs.some((ref) => ref.rollup)
  const document = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    ...fields,
    '  }',
    '  rateLimit { cost remaining resetAt limit }',
    '}',
    ...(usesCheckRollup ? ['', CHECK_ROLLUP_FRAGMENT] : []),
  ].join('\n')

  return { document, aliases }
}
