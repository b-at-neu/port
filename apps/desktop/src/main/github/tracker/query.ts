// Pure GraphQL document builders for the issue side — no network, no config read, no gh. GraphQL `search` is never
// used since it is index-backed with ingestion lag. The only home of an issue query.
import type { LabelVocabulary } from '@/utils/labels/vocabulary'
import type { ItemRef, SweepCursor } from '@/types/github'
import { ITEM_SWEEP_FIELDS, LABEL_EVENTS_FIELD, graphqlStringLiteral, sweepConnection } from '@/main/github/query'

const REPO_LABEL_PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 20
const ITEM_LABEL_PAGE_SIZE = 20
const BLOCKER_PAGE_SIZE = 20
const DETAIL_BLOCKER_PAGE_SIZE = 10
const BLOCKER_COMMENT_PAGE_SIZE = 10

const BLOCKER_COMMENTS_FIELD = `comments(last: ${BLOCKER_COMMENT_PAGE_SIZE}) { nodes { body createdAt url } }`
const CLOSING_PULL_REQUEST_PAGE_SIZE = 5
const CLOSING_PULL_REQUESTS_FIELD = `closedByPullRequestsReferences(first: ${CLOSING_PULL_REQUEST_PAGE_SIZE}, includeClosedPrs: true) { nodes { number state headRefName } }`

/** One connection whatever the label count; `labels:` matches any listed name. Only page one carries `repoLabels`/`viewer`, and `rateLimit` rides every page so cost sums.
 *  An empty `labels:` list filters nothing, so with no enabled label the connection is not asked at all and page one still runs. */
export function buildIssueSweepQuery(vocabulary: LabelVocabulary, after: SweepCursor): string {
  const names = vocabulary.labels.map((label) => graphqlStringLiteral(label.name)).join(', ')
  const first = after === null
  const repositoryFields = [
    ...(vocabulary.labels.length > 0 ? [sweepConnection('issues', names, after, ITEM_SWEEP_FIELDS)] : []),
    ...(first ? [`    repoLabels: labels(first: ${REPO_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`] : []),
  ]
  // Top-level, deliberately outside repository — resolving the signed-in login is never scoped
  // to one repository.
  return [
    'query($owner: String!, $name: String!) {',
    '  repository(owner: $owner, name: $name) {',
    ...repositoryFields,
    '  }',
    '  rateLimit { cost remaining resetAt limit }',
    ...(first ? ['  viewer { login }'] : []),
    '}',
  ].join('\n')
}

interface TrackedIssuesAlias {
  readonly alias: string
  readonly number: number
}

interface TrackedIssuesQuery {
  readonly document: string
  readonly aliases: readonly TrackedIssuesAlias[]
}

/** The sweep's own fields for tracked issues by number, so an issue whose labels are gone still reads. `<idx>` is the position. */
export function buildTrackedIssuesQuery(refs: readonly ItemRef[]): TrackedIssuesQuery {
  const aliases: TrackedIssuesAlias[] = []
  const fields: string[] = []
  refs.forEach((ref, idx) => {
    const alias = `t${idx}`
    fields.push(`  ${alias}: issue(number: ${ref.number}) { ${ITEM_SWEEP_FIELDS} }`)
    aliases.push({ alias, number: ref.number })
  })
  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '  rateLimit { cost remaining resetAt limit }', '}'].join('\n')
  return { document, aliases }
}

export interface IssueDetailRef {
  readonly number: number
  /** True only for an issue at the blocked stage — its newest comments carry the blocker's reason. */
  readonly blockerComments: boolean
  /** True only for an issue at `pr opened` — the pull requests closing it, whatever their state, since the open-only sweep cannot see a merged one. */
  readonly closingPullRequests: boolean
}

interface IssueDetailAlias extends IssueDetailRef {
  readonly alias: string
}

interface IssueDetailsQuery {
  readonly document: string
  readonly aliases: readonly IssueDetailAlias[]
}

/** The heavy fields the sweep leaves out, one aliased lookup per issue — priced per real item, not per page. `<idx>` is the position. */
export function buildIssueDetailsQuery(refs: readonly IssueDetailRef[]): IssueDetailsQuery {
  const aliases: IssueDetailAlias[] = []
  const fields: string[] = []

  refs.forEach((ref, idx) => {
    const alias = `d${idx}`
    const comments = ref.blockerComments ? ` ${BLOCKER_COMMENTS_FIELD}` : ''
    const closing = ref.closingPullRequests ? ` ${CLOSING_PULL_REQUESTS_FIELD}` : ''
    fields.push(`  ${alias}: issue(number: ${ref.number}) { ${LABEL_EVENTS_FIELD} ${blockedByField(DETAIL_BLOCKER_PAGE_SIZE)}${comments}${closing} }`)
    aliases.push({ ...ref, alias })
  })

  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '  rateLimit { cost remaining resetAt limit }', '}'].join('\n')
  return { document, aliases }
}

interface ItemsByNumberAlias {
  readonly alias: string
  readonly number: number
}

interface ItemsByNumberQuery {
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
      `  ${alias}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number title url state closedAt ${assigneesField} ${labelsField} } ... on PullRequest { number title url state mergedAt closedAt headRefName headRefOid author { login } ${assigneesField} ${labelsField} } }`,
    )
    aliases.push({ alias, number })
  })

  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '}'].join('\n')

  return { document, aliases }
}

interface GatePreflightQuery {
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

/** The one `blockedBy` selection, shared by every read that feeds `toBlockerRead`. */
export function blockedByField(pageSize: number): string {
  return `blockedBy(first: ${pageSize}) { totalCount nodes { number title url state } }`
}

export function blockingField(pageSize: number): string {
  return `blocking(first: ${pageSize}) { totalCount nodes { number title url state } }`
}

interface ClaimPreflightQuery {
  readonly document: string
}

/** The claim dialog's one round trip: the number's identity, labels, assignees, and open
 *  `blockedBy` edges, plus the signed-in account's login. A single-number, single-alias query (`c0`). */
export function buildClaimPreflightQuery(number: number): ClaimPreflightQuery {
  const labelsField = `labels(first: ${ITEM_LABEL_PAGE_SIZE}) { nodes { name } }`
  const assigneesField = `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`
  const issueFields = `number title url state ${labelsField} ${assigneesField} ${blockedByField(BLOCKER_PAGE_SIZE)}`

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
