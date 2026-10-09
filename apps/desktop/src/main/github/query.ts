// Pure GraphQL document builders — no network, no config read, no gh. One alias per (label ×
// surface); GraphQL `search` is never used since it is index-backed with ingestion lag.
import type { LabelVocabulary, ResolvedLabel } from '../../shared/labels/vocabulary'
import type { ItemRef, PipelineItemKind, QueriedLabel } from '../../shared/github/types'

const PAGE_SIZE = 100
const REPO_LABEL_PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 20
const ITEM_LABEL_PAGE_SIZE = 20
const BLOCKER_PAGE_SIZE = 20

/** A valid GraphQL StringValue for every escape `JSON.stringify` emits. */
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

// reviews/comments page sizes match scripts/port-tick/query.ts's own bound, for the cycle cap
// and zero-diff gate. mergeable is the mergeability precondition mergeabilityRoute reads.
const PULL_REQUEST_FRAGMENT = `fragment PullRequestFields on PullRequest {
  number
  title
  url
  body
  state
  mergedAt
  headRefOid
  mergeable
  assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }
  labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }
  reviews(first: 30) { totalCount nodes { body submittedAt commit { oid } } }
  comments(last: 20) { totalCount nodes { body createdAt } }
}`

// The statusCheckRollup selection the approval-withdrawal observation reads. Spread only into
// the pull-request alias whose label key is approved.
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

export interface PipelineQuery {
  readonly document: string
  readonly aliases: readonly QueriedLabel[]
}

/** One `issues`/`pullRequests` alias pair per enabled label. `<idx>` is the position, never
 *  derived from the label's own name, since a label name is arbitrary operator input. */
export function buildPipelineQuery(vocabulary: LabelVocabulary): PipelineQuery {
  const aliases: QueriedLabel[] = []
  const connections: string[] = []
  // GraphQL rejects a document declaring a fragment nothing spreads, so this is tracked to append
  // CHECK_ROLLUP_FRAGMENT only when an approved label actually exists this pass.
  let usesCheckRollup = false

  vocabulary.labels.forEach((label: ResolvedLabel, idx: number) => {
    const issueAlias = `i${idx}`
    const prAlias = `p${idx}`
    const literal = graphqlStringLiteral(label.name)
    // The approved alias alone also spreads CheckRollupFields; every other alias never selects it.
    const isApproved = label.key === 'approved'
    if (isApproved) usesCheckRollup = true
    const prFields = isApproved ? '...PullRequestFields ...CheckRollupFields' : '...PullRequestFields'
    connections.push(
      `  ${issueAlias}: issues(states: OPEN, first: ${PAGE_SIZE}, labels: [${literal}]) { totalCount nodes { ...IssueFields } }`,
      `  ${prAlias}: pullRequests(states: OPEN, first: ${PAGE_SIZE}, labels: [${literal}]) { totalCount nodes { ${prFields} } }`,
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
    // Top-level, deliberately outside repository — resolving the signed-in login is never scoped
    // to one repository.
    '  viewer { login }',
    '}',
    '',
    ISSUE_FRAGMENT,
    '',
    PULL_REQUEST_FRAGMENT,
    ...(usesCheckRollup ? ['', CHECK_ROLLUP_FRAGMENT] : []),
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

/** One `issueOrPullRequest(number:)` alias per input number — the kind is genuinely unknown here.
 *  `mergedAt` is selected only inside the `PullRequest` fragment, since `Issue` has no such field. */
export function buildItemsByNumberQuery(numbers: readonly number[]): ItemsByNumberQuery {
  const aliases: ItemsByNumberAlias[] = []
  const fields: string[] = []

  numbers.forEach((number, idx) => {
    const alias = `n${idx}`
    const labelsField = `labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`
    const assigneesField = `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`
    fields.push(
      `  ${alias}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number title url state closedAt ${assigneesField} ${labelsField} } ... on PullRequest { number title url state mergedAt closedAt ${assigneesField} ${labelsField} } }`,
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
  // Issues carry no mergedAt field at all — requesting it is a GraphQL validation error, not a null.
  return kind === 'pull-request' ? 'number state mergedAt closedAt url' : 'number state closedAt url'
}

/** One aliased `issue(number:)`/`pullRequest(number:)` per input item. The caller supplies
 *  `kind`, so a vanished number comes back as a partial error, handled by `envelope.ts`. */
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

export interface ClaimPreflightQuery {
  readonly document: string
}

/** The claim dialog's one round trip: the number's identity, labels, assignees, and open
 *  `blockedBy` edges, plus the signed-in account's login. A single-number, single-alias query (`c0`). */
export interface GatePreflightQuery {
  readonly document: string
}

/** The plan gate's one round trip: the number's identity, labels, assignees, and body, plus the
 *  signed-in account's login. `body` is requested only inside the `Issue` fragment. */
export function buildGatePreflightQuery(number: number): GatePreflightQuery {
  const labelsField = `labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`
  const assigneesField = `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`
  const issueFields = `number title url body state ${labelsField} ${assigneesField}`

  const document = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    c0: issueOrPullRequest(number: ${number}) { __typename ... on Issue { ${issueFields} } ... on PullRequest { number title url state } }`,
    '  }',
    '  viewer { login }',
    '}',
  ].join('\n')

  return { document }
}

export function buildClaimPreflightQuery(number: number): ClaimPreflightQuery {
  const labelsField = `labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`
  const assigneesField = `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`
  const blockedByField = `blockedBy(first: ${BLOCKER_PAGE_SIZE}) { totalCount nodes { number title url state } }`
  const issueFields = `number title url state ${labelsField} ${assigneesField} ${blockedByField}`

  const document = [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    `    c0: issueOrPullRequest(number: ${number}) { __typename ... on Issue { ${issueFields} } ... on PullRequest { number title url state } }`,
    '  }',
    '  viewer { login }',
    '}',
  ].join('\n')

  return { document }
}
