import { describe, expect, it } from 'vitest'
import { resolveVocabulary, type LabelVocabulary } from '@/utils/labels/vocabulary'
import { FIRST_SWEEP_PAGE, buildItemDetailsQuery, buildPipelineQuery, graphqlStringLiteral } from '@/main/github/query'

describe('graphqlStringLiteral', () => {
  it('round-trips a name containing a double quote, a backslash, and a newline', () => {
    const name = 'plan "approved"\\with\\backslashes\nand a newline'
    const literal = graphqlStringLiteral(name)
    expect(JSON.parse(literal)).toBe(name)
    // A GraphQL StringValue is single-line — no raw newline may appear in it.
    expect(literal.includes('\n')).toBe(false)
  })

  it('is the identity for a plain name', () => {
    expect(JSON.parse(graphqlStringLiteral('ready'))).toBe('ready')
  })
})

function countOf(document: string, needle: string): number {
  return document.split(needle).length - 1
}

describe('buildPipelineQuery', () => {
  it('has one issues and one pullRequests connection whatever the label count', () => {
    const two: LabelVocabulary = {
      labels: [
        { key: 'ready', name: 'ready', source: 'default', module: 'core', role: 'trigger' },
        { key: 'blocked', name: 'blocked', source: 'default', module: 'core', role: 'gate' },
      ],
      disabled: [],
      problems: [],
    }
    const all = resolveVocabulary({})
    expect(all.labels.length).toBeGreaterThan(two.labels.length)
    for (const vocabulary of [two, all]) {
      const document = buildPipelineQuery(vocabulary, FIRST_SWEEP_PAGE)
      expect(countOf(document, 'issues(')).toBe(1)
      expect(countOf(document, 'pullRequests(')).toBe(1)
    }
  })

  it('two vocabularies differ only inside the labels list', () => {
    const base = resolveVocabulary({})
    const fewer: LabelVocabulary = { ...base, labels: base.labels.slice(0, 2) }
    const withoutList = (document: string): string => document.replace(/labels: \[[^\]]*\]/g, 'labels: []')
    expect(withoutList(buildPipelineQuery(base, FIRST_SWEEP_PAGE))).toBe(withoutList(buildPipelineQuery(fewer, FIRST_SWEEP_PAGE)))
    expect(buildPipelineQuery(base, FIRST_SWEEP_PAGE)).not.toBe(buildPipelineQuery(fewer, FIRST_SWEEP_PAGE))
  })

  it('lists every enabled name and none for a disabled one', () => {
    const vocabulary: LabelVocabulary = {
      labels: [
        { key: 'ready', name: 'ready', source: 'default', module: 'core', role: 'trigger' },
        { key: 'blocked', name: 'blocked', source: 'default', module: 'core', role: 'gate' },
      ],
      disabled: ['refreshBranch', 'refreshing'],
      problems: [],
    }
    const document = buildPipelineQuery(vocabulary, FIRST_SWEEP_PAGE)
    expect(document).toContain('labels: ["ready", "blocked"]')
    expect(document).not.toContain('refresh')
  })

  it('a label name containing a double quote round-trips through the built document', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'weird "quoted" label' } })
    expect(buildPipelineQuery(vocabulary, FIRST_SWEEP_PAGE)).toContain(graphqlStringLiteral('weird "quoted" label'))
  })

  it('every connection carries totalCount, and each sweep connection its pageInfo', () => {
    const document = buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)
    const lines = document.split('\n').filter((line) => /^\s*(issues|pullRequests|repoLabels):/.test(line))
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(line).toContain('totalCount')
    for (const line of lines.filter((l) => !l.includes('repoLabels'))) expect(line).toContain('pageInfo { hasNextPage endCursor }')
  })

  it('never uses GraphQL search', () => {
    expect(buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)).not.toContain('search(')
  })

  it('holds none of the heavy fields the detail read owns', () => {
    const document = buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)
    for (const heavy of ['reviews', 'comments', 'timelineItems', 'commits', 'statusCheckRollup']) expect(document).not.toContain(heavy)
  })

  it('carries the light fields both stages read, and the pull request extras only on pullRequests', () => {
    const document = buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)
    const issues = document.split('\n').find((line) => line.includes('issues(')) ?? ''
    const pulls = document.split('\n').find((line) => line.includes('pullRequests(')) ?? ''
    for (const line of [issues, pulls]) {
      for (const field of ['updatedAt', 'assignees(first: 20)', 'labels(first: 100)']) expect(line).toContain(field)
    }
    for (const field of ['headRefOid', 'mergeable', 'mergedAt']) {
      expect(pulls).toContain(field)
      expect(issues).not.toContain(field)
    }
  })

  it('requests viewer as a top-level field, outside repository', () => {
    const document = buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)
    const repositoryStart = document.indexOf('repository(owner:')
    const viewerIndex = document.indexOf('viewer { login }')
    expect(viewerIndex).toBeGreaterThan(-1)
    const closeIndex = document.indexOf('\n  }\n', repositoryStart)
    expect(viewerIndex).toBeGreaterThan(closeIndex)
  })

  it('a later page omits repoLabels and viewer, keeps rateLimit, and asks only for the surface still paging', () => {
    const vocabulary = resolveVocabulary({})
    const document = buildPipelineQuery(vocabulary, { issues: false, pulls: true, issuesAfter: null, pullsAfter: 'cursor-1' })
    expect(document).not.toContain('repoLabels')
    expect(document).not.toContain('viewer')
    expect(document).not.toContain('issues(')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
    expect(document).toContain('pullRequests(states: OPEN, first: 100')
    expect(document).toContain('after: "cursor-1"')
  })

  it('the first page passes a null cursor and orders oldest first', () => {
    const document = buildPipelineQuery(resolveVocabulary({}), FIRST_SWEEP_PAGE)
    expect(document).toContain('after: null')
    expect(document).toContain('orderBy: {field: CREATED_AT, direction: ASC}')
  })
})

describe('buildItemDetailsQuery', () => {
  const issue = { kind: 'issue', rollup: false, blockerComments: false, closingPullRequests: false } as const
  const pull = { kind: 'pull-request', rollup: false, blockerComments: false, closingPullRequests: false } as const
  const lineOf = (document: string, alias: string) => document.split('\n').find((line) => line.includes(`${alias}:`)) ?? ''

  it('emits one aliased lookup per item, in order, by kind', () => {
    const { document, aliases } = buildItemDetailsQuery([
      { ...issue, number: 7 },
      { ...pull, number: 9 },
    ])
    expect(aliases).toEqual([
      { ...issue, alias: 'd0', number: 7 },
      { ...pull, alias: 'd1', number: 9 },
    ])
    expect(document).toContain('d0: issue(number: 7)')
    expect(document).toContain('d1: pullRequest(number: 9)')
  })

  it('an issue reads its label timeline and blockedBy; a pull request also reads reviews and comments', () => {
    const { document } = buildItemDetailsQuery([
      { ...issue, number: 7 },
      { ...pull, number: 9 },
    ])
    expect(lineOf(document, 'd0')).toContain('blockedBy(first: 10)')
    expect(lineOf(document, 'd0')).not.toContain('reviews')
    expect(lineOf(document, 'd0')).not.toContain('comments')
    expect(lineOf(document, 'd1')).toContain('reviews(first: 30)')
    expect(lineOf(document, 'd1')).toContain('comments(last: 20)')
    expect(lineOf(document, 'd1')).not.toContain('blockedBy')
    for (const alias of ['d0', 'd1']) expect(lineOf(document, alias)).toContain('itemTypes: [LABELED_EVENT]')
  })

  it('selects an issue comments connection only when its blockerComments flag is set', () => {
    const { document } = buildItemDetailsQuery([
      { ...issue, number: 7, blockerComments: true },
      { ...issue, number: 8 },
    ])
    expect(lineOf(document, 'd0')).toContain('comments(last: 10) { nodes { body createdAt url } }')
    expect(lineOf(document, 'd1')).not.toContain('comments')
  })

  it('selects closing pull requests only when the flag is set, and never on a pull request alias', () => {
    const { document } = buildItemDetailsQuery([
      { ...issue, number: 7, closingPullRequests: true },
      { ...issue, number: 8 },
      { ...pull, number: 9, closingPullRequests: true },
    ])
    expect(lineOf(document, 'd0')).toContain('closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state headRefName } }')
    expect(lineOf(document, 'd1')).not.toContain('closedByPullRequestsReferences')
    expect(lineOf(document, 'd2')).not.toContain('closedByPullRequestsReferences')
  })

  it('spreads CheckRollupFields, and declares it, only when a pull request asks for the rollup', () => {
    expect(buildItemDetailsQuery([{ ...pull, number: 9 }]).document).not.toContain('CheckRollupFields')
    const withRollup = buildItemDetailsQuery([
      { ...pull, number: 9 },
      { ...pull, number: 10, rollup: true },
    ]).document
    expect(withRollup).toContain('d1: pullRequest(number: 10) {')
    expect(countOf(withRollup, '...CheckRollupFields')).toBe(1)
    expect(withRollup).toContain('fragment CheckRollupFields on PullRequest')
  })

  it('carries rateLimit, so every round trip reports its own cost', () => {
    expect(buildItemDetailsQuery([{ ...issue, number: 1 }]).document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})
