import { describe, expect, it } from 'vitest'
import { resolveDisplayVocabulary, type DisplayVocabulary } from '@/utils/labels/display'
import { FIRST_SWEEP_PAGE, buildPullDetailsQuery, buildPullSweepQuery, buildTrackedPullsQuery, graphqlStringLiteral } from '@/main/github/query'

describe('graphqlStringLiteral', () => {
  it('round-trips a name containing a double quote, a backslash, and a newline', () => {
    const name = 'plan "approved"\\with\\backslashes\nand a newline'
    const literal = graphqlStringLiteral(name)
    expect(JSON.parse(literal)).toBe(name)
    // A GraphQL StringValue is single-line — no raw newline may appear in it.
    expect(literal.includes('\n')).toBe(false)
  })
})

function countOf(document: string, needle: string): number {
  return document.split(needle).length - 1
}

const lineOf = (document: string, alias: string) => document.split('\n').find((line) => line.includes(`${alias}:`)) ?? ''

describe('buildPullSweepQuery', () => {
  const two: DisplayVocabulary = {
    labels: [
      { key: 'port', name: 'port', source: 'default', role: 'marker', palette: null },
      { key: 'needsYou', name: 'needs you', source: 'default', role: 'gate', palette: 'needs-you' },
    ],
    problems: [],
  }
  const all = resolveDisplayVocabulary({})

  it('has one pullRequests connection and no issue field whatever the label count', () => {
    for (const vocabulary of [two, all]) {
      const document = buildPullSweepQuery(vocabulary, FIRST_SWEEP_PAGE, 'dev')
      expect(countOf(document, 'pullRequests(')).toBe(1)
      expect(document).not.toContain('issues(')
      expect(document).not.toContain('repoLabels')
      expect(document).not.toContain('viewer')
    }
  })

  it('lists every name and escapes a quoted one', () => {
    expect(buildPullSweepQuery(two, FIRST_SWEEP_PAGE, 'dev')).toContain('labels: ["port", "needs you"]')
    const quoted = resolveDisplayVocabulary({ labels: { needsYou: 'weird "quoted" label' } })
    expect(buildPullSweepQuery(quoted, FIRST_SWEEP_PAGE, 'dev')).toContain(graphqlStringLiteral('weird "quoted" label'))
  })

  it('carries totalCount, pageInfo, the pull request extras, an oldest-first order and none of the heavy fields', () => {
    const document = buildPullSweepQuery(all, FIRST_SWEEP_PAGE, 'dev')
    const line = lineOf(document, 'pullRequests')
    for (const field of ['totalCount', 'pageInfo { hasNextPage endCursor }', 'updatedAt', 'assignees(first: 20)', 'labels(first: 100)', 'headRefOid', 'mergeable', 'mergedAt', 'after: null', 'orderBy: {field: CREATED_AT, direction: ASC}']) expect(line).toContain(field)
    for (const heavy of ['reviews', 'comments', 'timelineItems', 'commits {', 'search(']) expect(document).not.toContain(heavy)
  })

  it('the first page carries the integration history, with rateLimit, and a later page only the cursor and rateLimit', () => {
    const first = buildPullSweepQuery(all, FIRST_SWEEP_PAGE, 'dev')
    expect(first).toContain('integrationHistory: ref(qualifiedName: "refs/heads/dev")')
    const later = buildPullSweepQuery(all, { connection: true, after: 'cursor-1' }, 'dev')
    expect(later).not.toContain('integrationHistory')
    expect(later).toContain('after: "cursor-1"')
    for (const document of [first, later]) expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })

  it('with no connection asked, page one is the integration history alone', () => {
    const document = buildPullSweepQuery(all, { connection: false, after: null }, 'dev')
    expect(document).not.toContain('pullRequests(')
    expect(document).toContain('integrationHistory:')
  })
})

describe('buildTrackedPullsQuery', () => {
  it('aliases each tracked pull request by position and selects the sweep fields by number, never by label', () => {
    const { document, aliases } = buildTrackedPullsQuery([7, 9])
    expect(aliases).toEqual([
      { alias: 't0', number: 7 },
      { alias: 't1', number: 9 },
    ])
    expect(lineOf(document, 't0')).toContain('t0: pullRequest(number: 7) { number title url body state updatedAt')
    expect(lineOf(document, 't1')).toContain('headRefOid mergeable')
    expect(document).not.toContain('labels: [')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})

describe('buildPullDetailsQuery', () => {
  it('emits one aliased lookup per pull request, in order, reading the timeline, reviews and comments', () => {
    const { document, aliases } = buildPullDetailsQuery([
      { number: 7, rollup: false },
      { number: 9, rollup: false },
    ])
    expect(aliases).toEqual([
      { alias: 'd0', number: 7 },
      { alias: 'd1', number: 9 },
    ])
    expect(lineOf(document, 'd0')).toContain('d0: pullRequest(number: 7)')
    for (const field of ['reviews(first: 30)', 'comments(last: 20)', 'itemTypes: [LABELED_EVENT]']) expect(lineOf(document, 'd1')).toContain(field)
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })

  it('spreads CheckRollupFields, and declares it, only when a pull request asks for the rollup', () => {
    expect(buildPullDetailsQuery([{ number: 9, rollup: false }]).document).not.toContain('CheckRollupFields')
    const withRollup = buildPullDetailsQuery([
      { number: 9, rollup: false },
      { number: 10, rollup: true },
    ]).document
    expect(lineOf(withRollup, 'd1')).toContain('...CheckRollupFields')
    expect(countOf(withRollup, '...CheckRollupFields')).toBe(1)
    expect(withRollup).toContain('fragment CheckRollupFields on PullRequest')
  })
})
