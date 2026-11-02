// Pure GraphQL document builders — no network, no config read, no gh. GraphQL `search` is never
// used since it is index-backed with ingestion lag.
import type { LabelVocabulary, ResolvedLabel } from '@/utils/labels/vocabulary'
import type { ItemRef, PipelineItemKind, SweepAlias, SweepPage } from '@/types/github'

const PAGE_SIZE = 100
const REPO_LABEL_PAGE_SIZE = 100
const ASSIGNEE_PAGE_SIZE = 20
const ITEM_LABEL_PAGE_SIZE = 20
const SWEEP_LABEL_PAGE_SIZE = 100
const BLOCKER_PAGE_SIZE = 20
const LABEL_EVENT_PAGE_SIZE = 20
const DETAIL_BLOCKER_PAGE_SIZE = 10
const BLOCKER_COMMENT_PAGE_SIZE = 10

/** A valid GraphQL StringValue for every escape `JSON.stringify` emits. */
export function graphqlStringLiteral(value: string): string {
  return JSON.stringify(value)
}

// Shared by both fragments — Needs you's newest-first sort key, and the stage-move history
// reconcile.ts resolves into stageHistory.
const LABEL_EVENTS_FIELD = `timelineItems(last: ${LABEL_EVENT_PAGE_SIZE}, itemTypes: [LABELED_EVENT]) { nodes { ... on LabeledEvent { createdAt actor { login } label { name } } } }`

const ISSUE_SWEEP_FIELDS = `number title url body state updatedAt assignees(first: ${ASSIGNEE_PAGE_SIZE}) { nodes { login } } labels(first: ${SWEEP_LABEL_PAGE_SIZE}) { totalCount nodes { name } }`

const BLOCKER_COMMENTS_FIELD = `comments(last: ${BLOCKER_COMMENT_PAGE_SIZE}) { nodes { body createdAt url } }`

// mergeable is the mergeability precondition mergeabilityRoute reads.
const PULL_REQUEST_SWEEP_FIELDS = `${ISSUE_SWEEP_FIELDS} mergedAt headRefOid mergeable`

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

export const FIRST_SWEEP_PAGE: SweepPage = { issues: true, pulls: true, issuesAfter: null, pullsAfter: null }

function sweepConnection(alias: SweepAlias, field: string, names: string, after: string | null, fields: string): string {
  const cursor = after === null ? 'null' : graphqlStringLiteral(after)
  return `  ${alias}: ${field}(states: OPEN, first: ${PAGE_SIZE}, labels: [${names}], after: ${cursor}, orderBy: {field: CREATED_AT, direction: ASC}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} } }`
}

/** One connection per surface whatever the label count; `labels:` matches any listed name. Only
 *  page one carries `repoLabels`/`viewer`, and `rateLimit` rides every page so cost sums. */
export function buildPipelineQuery(vocabulary: LabelVocabulary, page: SweepPage): string {
  const names = vocabulary.labels.map((label: ResolvedLabel) => graphqlStringLiteral(label.name)).join(', ')
  const first = page.issuesAfter === null && page.pullsAfter === null
  const repositoryFields = [
    ...(page.issues ? [sweepConnection('issues', 'issues', names, page.issuesAfter, ISSUE_SWEEP_FIELDS)] : []),
    ...(page.pulls ? [sweepConnection('pullRequests', 'pullRequests', names, page.pullsAfter, PULL_REQUEST_SWEEP_FIELDS)] : []),
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

/** `rollup` is true only for a pull request at the approved or ready-for-review stage. */
export interface ItemDetailRef {
  readonly kind: PipelineItemKind
  readonly number: number
  readonly rollup: boolean
  /** True only for an issue at the blocked stage — its newest comments carry the blocker's reason. */
  readonly blockerComments: boolean
}

interface ItemDetailAlias extends ItemDetailRef {
  readonly alias: string
}

interface ItemDetailsQuery {
  readonly document: string
  readonly aliases: readonly ItemDetailAlias[]
}

/** The heavy fields the sweep leaves out, one aliased lookup per item — priced per real item, not
 *  per page. `<idx>` is the position, since the number alone cannot name an issue and a pull request. */
export function buildItemDetailsQuery(refs: readonly ItemDetailRef[]): ItemDetailsQuery {
  const aliases: ItemDetailAlias[] = []
  const fields: string[] = []

  refs.forEach((ref, idx) => {
    const alias = `d${idx}`
    if (ref.kind === 'issue') {
      const comments = ref.blockerComments ? ` ${BLOCKER_COMMENTS_FIELD}` : ''
      fields.push(`  ${alias}: issue(number: ${ref.number}) { ${LABEL_EVENTS_FIELD} ${blockedByField(DETAIL_BLOCKER_PAGE_SIZE)}${comments} }`)
    } else {
      const rollup = ref.rollup ? ' ...CheckRollupFields' : ''
      fields.push(`  ${alias}: pullRequest(number: ${ref.number}) { ${PULL_REQUEST_DETAIL_FIELDS}${rollup} }`)
    }
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
      `  ${alias}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number title url state closedAt ${assigneesField} ${labelsField} } ... on PullRequest { number title url state mergedAt closedAt headRefName ${assigneesField} ${labelsField} } }`,
    )
    aliases.push({ alias, number })
  })

  const document = ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...fields, '  }', '}'].join('\n')

  return { document, aliases }
}

interface ItemStateAlias {
  readonly alias: string
  readonly kind: PipelineItemKind
  readonly number: number
}

interface ItemStatesQuery {
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

interface ClaimPreflightQuery {
  readonly document: string
}

/** The claim dialog's one round trip: the number's identity, labels, assignees, and open
 *  `blockedBy` edges, plus the signed-in account's login. A single-number, single-alias query (`c0`). */
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
