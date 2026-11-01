// Pure GraphQL builders for the Releases reads — every branch and path travels as a variable, never spliced into the document.
const RELEASES_PAGE = 20
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
  const variables = ['$owner: String!', '$name: String!', '$production: String!', '$integration: String!', '$integrationRef: String!', '$productionRef: String!', ...(withFiles ? ['$integrationFile: String!', '$productionFile: String!'] : [])]
  return [
    `query(${variables.join(', ')}) {`,
    '  repository(owner: $owner, name: $name) {',
    `    releases(first: ${String(RELEASES_PAGE)}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName name url publishedAt isDraft isPrerelease isLatest description } }`,
    `    openReleasePr: pullRequests(states: OPEN, baseRefName: $production, headRefName: $integration, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`,
    `    closedReleasePr: pullRequests(states: [CLOSED, MERGED], baseRefName: $production, headRefName: $integration, first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`,
    `    bumpRefs: refs(refPrefix: "refs/heads/bump/v", first: ${String(BUMP_REFS_PAGE)}) { nodes { name associatedPullRequests(states: OPEN, first: 1) { nodes { number url } } } }`,
    ...files,
    '    integrationHead: ref(qualifiedName: $integrationRef) { target { oid ... on Commit { tree { oid } } } }',
    '    productionHead: ref(qualifiedName: $productionRef) { target { oid } }',
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
    ...(params.versionFile === null ? {} : { integrationFile: `${params.integration}:${params.versionFile}`, productionFile: `${params.production}:${params.versionFile}` }),
  }
}

/** Resolves ticket numbers through `issueOrPullRequest`; the numbers are integers the caller extracted, so inlining them is safe. */
export function buildTicketsQuery(numbers: readonly number[]): string {
  const fields = `title labels(first: ${String(TICKET_LABEL_PAGE)}) { nodes { name } } author { __typename login }`
  const aliases = numbers.map((n) => `    t${String(n)}: issueOrPullRequest(number: ${String(Math.trunc(n))}) { ... on Issue { ${fields} } ... on PullRequest { ${fields} } }`)
  return ['query($owner: String!, $name: String!) {', '  repository(owner: $owner, name: $name) {', ...aliases, '  }', '}'].join('\n')
}
