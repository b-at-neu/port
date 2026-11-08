import { BUMP_BRANCH_DIR } from '@/utils/release/format'

// Pure GraphQL builders for the Releases reads — every branch and path travels as a variable, never spliced into the document.
export const RELEASES_PAGE = 20
const BUMP_REFS_PAGE = 10
const TICKET_LABEL_PAGE = 20

/** The aliases of `buildStateQuery`; each one feeds the phase, so one unavailable alias fails the whole status. */
export const STATE_ALIASES = ['releases', 'openReleasePr', 'closedReleasePr', 'bumpRefs', 'integrationFile', 'productionFile', 'integrationHead', 'productionHead'] as const

const PR_FIELDS = 'number url title state merged'

// `withFiles` is false for `tags`, where no manifest carries the version.
export function buildStateQuery(withFiles: boolean): string {
  const files = withFiles
    ? [
        '    integrationFile: object(expression: $integrationFile) { ... on Blob { text } }',
        '    productionFile: object(expression: $productionFile) { ... on Blob { text } }',
      ]
    : []
  const variables = ['$owner: String!', '$name: String!', '$production: String!', '$integration: String!', '$integrationRef: String!', '$productionRef: String!', '$bumpRefPrefix: String!', ...(withFiles ? ['$integrationFile: String!', '$productionFile: String!'] : [])]
  return [
    `query(${variables.join(', ')}) {`,
    '  repository(owner: $owner, name: $name) {',
    `    releases(first: ${String(RELEASES_PAGE + 1)}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName name url publishedAt isDraft isPrerelease isLatest description tagCommit { committedDate } } }`,
    `    openReleasePr: pullRequests(states: OPEN, baseRefName: $production, headRefName: $integration, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`,
    `    closedReleasePr: pullRequests(states: [CLOSED, MERGED], baseRefName: $production, headRefName: $integration, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`,
    `    bumpRefs: refs(refPrefix: $bumpRefPrefix, first: ${String(BUMP_REFS_PAGE)}) { nodes { name associatedPullRequests(states: OPEN, first: 1) { nodes { number url } } } }`,
    ...files,
    '    integrationHead: ref(qualifiedName: $integrationRef) { target { oid ... on Commit { tree { oid } } } }',
    '    productionHead: ref(qualifiedName: $productionRef) { target { oid ... on Commit { committedDate } } }',
    '  }',
    '  viewer { login }',
    '}',
  ].join('\n')
}

/** The two files' blob expressions and both ref names for `buildStateQuery`'s variables. */
export function stateVariables(params: { readonly integration: string; readonly production: string; readonly versionFile: string | null }): Readonly<Record<string, string>> {
  return {
    production: params.production,
    integration: params.integration,
    integrationRef: `refs/heads/${params.integration}`,
    productionRef: `refs/heads/${params.production}`,
    bumpRefPrefix: `refs/heads/${BUMP_BRANCH_DIR}`,
    ...(params.versionFile === null ? {} : { integrationFile: `${params.integration}:${params.versionFile}`, productionFile: `${params.production}:${params.versionFile}` }),
  }
}

/** One aliased commit lookup per sha, each declared as a `GitObjectID!` variable `$c0…$cN`; a sha is never spliced into the document. */
export function buildIncludedIssuesQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index)
  const issue = `number title url repository { nameWithOwner } labels(first: ${String(TICKET_LABEL_PAGE)}) { nodes { name color } }`
  const aliases = indexes.map((n) => `    c${String(n)}: object(oid: $c${String(n)}) { ... on Commit { associatedPullRequests(first: 3) { nodes { merged closingIssuesReferences(first: 10) { nodes { ${issue} } } } } } }`)
  return [`query($owner: String!, $name: String!${indexes.map((n) => `, $c${String(n)}: GitObjectID!`).join('')}) {`, '  repository(owner: $owner, name: $name) {', ...aliases, '  }', '}'].join('\n')
}

export const MERGED_PRS_PAGE = 100
const MERGED_PR_LABELS = 10

/** One page of pull requests merged into `$base`, most recently updated first; `$after` is the previous page's cursor. */
export function buildMergedPrsQuery(): string {
  return [
    'query($owner: String!, $name: String!, $base: String!, $after: String) {',
    '  repository(owner: $owner, name: $name) {',
    `    pullRequests(states: MERGED, baseRefName: $base, first: ${String(MERGED_PRS_PAGE)}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {`,
    '      pageInfo { hasNextPage endCursor }',
    `      nodes { number title url mergedAt updatedAt author { __typename } labels(first: ${String(MERGED_PR_LABELS)}) { nodes { name color } } }`,
    '    }',
    '  }',
    '}',
  ].join('\n')
}
