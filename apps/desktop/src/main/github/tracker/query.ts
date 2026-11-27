// Pure GraphQL document builders for the tracker's reads — no network, no config read, no gh.
import type { SweepPage } from '@/types/github'
import type { DisplayVocabulary } from '@/utils/labels/display'
import { ASSIGNEE_PAGE_SIZE, ITEM_SWEEP_FIELDS, LABEL_EVENTS_FIELD, repositoryDocument, sweepConnection } from '@/main/github/query'
import type { NumberedQuery } from '@/main/github/query'

const ITEM_LABEL_PAGE_SIZE = 20
const BLOCKER_PAGE_SIZE = 20
const REPO_LABEL_PAGE_SIZE = 100
const DETAIL_BLOCKER_PAGE_SIZE = 10
const BLOCKER_COMMENT_PAGE_SIZE = 10
const CLOSING_PULL_REQUEST_PAGE_SIZE = 5

const BLOCKER_COMMENTS_FIELD = `comments(last: ${BLOCKER_COMMENT_PAGE_SIZE}) { nodes { body createdAt url } }`
const CLOSING_PULL_REQUESTS_FIELD = `closedByPullRequestsReferences(first: ${CLOSING_PULL_REQUEST_PAGE_SIZE}, includeClosedPrs: true) { nodes { number state headRefName } }`

/** The issue sweep page. Only page one carries `repoLabels` and `viewer`. The viewer is top-level, deliberately outside `repository`: resolving the signed-in login is never scoped to one repository. */
export function buildIssueSweepQuery(vocabulary: DisplayVocabulary, page: SweepPage): string {
  const first = page.after === null
  return repositoryDocument(
    [...(page.connection ? [sweepConnection('issues', vocabulary, page, ITEM_SWEEP_FIELDS)] : []), ...(first ? [`    repoLabels: labels(first: ${REPO_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`] : [])],
    first ? ['  viewer { login }'] : [],
  )
}

/** The sweep's own fields for tracked issues by number, so one whose labels are gone still reads. `<idx>` is the position in `numbers`. */
export function buildTrackedIssuesQuery(numbers: readonly number[]): NumberedQuery {
  const aliases = numbers.map((number, idx) => ({ alias: `t${idx}`, number }))
  return { document: repositoryDocument(aliases.map(({ alias, number }) => `  ${alias}: issue(number: ${number}) { ${ITEM_SWEEP_FIELDS} }`)), aliases }
}

export interface IssueDetailRef {
  readonly number: number
  /** True only for an issue at the blocked stage — its newest comments carry the blocker's reason. */
  readonly blockerComments: boolean
  /** True only for an issue that may already have opened its pull request — the pull requests closing it, whatever their state, since the open-only sweep cannot see a merged one. */
  readonly closingPullRequests: boolean
}

/** The heavy fields the sweep leaves out, one aliased lookup per issue — priced per real item, not per page. */
export function buildIssueDetailsQuery(refs: readonly IssueDetailRef[]): NumberedQuery {
  const aliases = refs.map((ref, idx) => ({ alias: `d${idx}`, number: ref.number }))
  const fields = refs.map((ref, idx) => {
    const comments = ref.blockerComments ? ` ${BLOCKER_COMMENTS_FIELD}` : ''
    const closing = ref.closingPullRequests ? ` ${CLOSING_PULL_REQUESTS_FIELD}` : ''
    return `  d${idx}: issue(number: ${ref.number}) { ${LABEL_EVENTS_FIELD} ${blockedByField(DETAIL_BLOCKER_PAGE_SIZE)}${comments}${closing} }`
  })
  return { document: repositoryDocument(fields), aliases }
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

interface ClaimPreflightQuery {
  readonly document: string
}

interface GatePreflightQuery {
  readonly document: string
}

/** The plan gate's one round trip: the number's identity, assignees, and body, plus the
 *  signed-in account's login. `body` is requested only inside the `Issue` fragment. */
export function buildGatePreflightQuery(number: number): GatePreflightQuery {
  const assigneesField = `assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } }`
  const issueFields = `number title url body state ${assigneesField}`

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
