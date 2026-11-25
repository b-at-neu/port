// Pure GraphQL document builders for the tracker's point reads — no network, no config read, no gh.
export const ASSIGNEE_PAGE_SIZE = 20
const ITEM_LABEL_PAGE_SIZE = 20
const BLOCKER_PAGE_SIZE = 20

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
