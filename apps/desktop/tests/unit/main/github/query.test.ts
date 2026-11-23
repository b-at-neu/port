import { describe, expect, it } from 'vitest'
import { resolveVocabulary, type LabelVocabulary } from '@/utils/labels/vocabulary'
import { buildPullRequestDetailsQuery, buildPullRequestSweepQuery, buildTrackedPullRequestsQuery, graphqlStringLiteral } from '@/main/github/query'

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

describe('buildPullRequestSweepQuery', () => {
  it('has one pullRequests connection and no issues connection whatever the label count', () => {
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
      const document = buildPullRequestSweepQuery(vocabulary, null, 'dev')
      expect(countOf(document, 'pullRequests(')).toBe(1)
      expect(countOf(document, 'issues(')).toBe(0)
    }
  })

  it('two vocabularies differ only inside the labels list', () => {
    const base = resolveVocabulary({})
    const fewer: LabelVocabulary = { ...base, labels: base.labels.slice(0, 2) }
    const withoutList = (document: string): string => document.replace(/labels: \[[^\]]*\]/g, 'labels: []')
    expect(withoutList(buildPullRequestSweepQuery(base, null, 'dev'))).toBe(withoutList(buildPullRequestSweepQuery(fewer, null, 'dev')))
    expect(buildPullRequestSweepQuery(base, null, 'dev')).not.toBe(buildPullRequestSweepQuery(fewer, null, 'dev'))
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
    const document = buildPullRequestSweepQuery(vocabulary, null, 'dev')
    expect(document).toContain('labels: ["ready", "blocked"]')
    expect(document).not.toContain('refresh')
  })

  it('a label name containing a double quote round-trips through the built document', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'weird "quoted" label' } })
    expect(buildPullRequestSweepQuery(vocabulary, null, 'dev')).toContain(graphqlStringLiteral('weird "quoted" label'))
  })

  it('the connection carries totalCount and pageInfo', () => {
    const document = buildPullRequestSweepQuery(resolveVocabulary({}), null, 'dev')
    const line = document.split('\n').find((l) => /^\s*pullRequests:/.test(l)) ?? ''
    expect(line).toContain('totalCount')
    expect(line).toContain('pageInfo { hasNextPage endCursor }')
  })

  it('never uses GraphQL search', () => {
    expect(buildPullRequestSweepQuery(resolveVocabulary({}), null, 'dev')).not.toContain('search(')
  })

  it('holds none of the heavy fields the detail read owns', () => {
    const document = buildPullRequestSweepQuery(resolveVocabulary({}), null, 'dev')
    const connection = document.split('\n').find((l) => /^\s*pullRequests:/.test(l)) ?? ''
    for (const heavy of ['reviews', 'comments', 'timelineItems', 'commits', 'statusCheckRollup']) expect(connection).not.toContain(heavy)
  })

  it('carries the light fields and the pull request extras', () => {
    const document = buildPullRequestSweepQuery(resolveVocabulary({}), null, 'dev')
    const pulls = document.split('\n').find((line) => line.includes('pullRequests(')) ?? ''
    for (const field of ['updatedAt', 'assignees(first: 20)', 'labels(first: 100)', 'headRefOid', 'mergeable', 'mergedAt']) expect(pulls).toContain(field)
  })

  it('page one reads the integration branch history, a later page does not', () => {
    const vocabulary = resolveVocabulary({})
    expect(buildPullRequestSweepQuery(vocabulary, null, 'dev')).toContain('integrationHistory: ref(qualifiedName: "refs/heads/dev")')
    const later = buildPullRequestSweepQuery(vocabulary, 'cursor-1', 'dev')
    expect(later).not.toContain('integrationHistory')
    expect(later).toContain('rateLimit { cost remaining resetAt limit }')
    expect(later).toContain('pullRequests(states: OPEN, first: 100')
    expect(later).toContain('after: "cursor-1"')
  })

  it('with no enabled label page one still asks for the integration history and no connection', () => {
    const document = buildPullRequestSweepQuery({ labels: [], disabled: [], problems: [] }, null, 'dev')
    expect(document).not.toContain('pullRequests(')
    expect(document).toContain('integrationHistory')
  })

  it('the first page passes a null cursor and orders oldest first', () => {
    const document = buildPullRequestSweepQuery(resolveVocabulary({}), null, 'dev')
    expect(document).toContain('after: null')
    expect(document).toContain('orderBy: {field: CREATED_AT, direction: ASC}')
  })
})

describe('buildPullRequestDetailsQuery', () => {
  it('emits one aliased lookup per pull request, in order', () => {
    const { document, aliases } = buildPullRequestDetailsQuery([
      { number: 7, rollup: false },
      { number: 9, rollup: false },
    ])
    expect(aliases).toEqual([
      { alias: 'd0', number: 7, rollup: false },
      { alias: 'd1', number: 9, rollup: false },
    ])
    expect(document).toContain('d0: pullRequest(number: 7)')
    expect(document).toContain('d1: pullRequest(number: 9)')
  })

  it('reads the label timeline, reviews and comments, and never blockedBy', () => {
    const { document } = buildPullRequestDetailsQuery([{ number: 9, rollup: false }])
    const pull = document.split('\n').find((line) => line.includes('d0:')) ?? ''
    expect(pull).toContain('itemTypes: [LABELED_EVENT]')
    expect(pull).toContain('reviews(first: 30)')
    expect(pull).toContain('comments(last: 20)')
    expect(pull).not.toContain('blockedBy')
  })

  it('spreads CheckRollupFields, and declares it, only when a pull request asks for the rollup', () => {
    const without = buildPullRequestDetailsQuery([{ number: 9, rollup: false }]).document
    expect(without).not.toContain('CheckRollupFields')
    const withRollup = buildPullRequestDetailsQuery([
      { number: 9, rollup: false },
      { number: 10, rollup: true },
    ]).document
    expect(withRollup).toContain('d1: pullRequest(number: 10) {')
    expect(withRollup).toContain('...CheckRollupFields')
    expect(countOf(withRollup, '...CheckRollupFields')).toBe(1)
    expect(withRollup).toContain('fragment CheckRollupFields on PullRequest')
  })

  it('carries rateLimit, so every round trip reports its own cost', () => {
    expect(buildPullRequestDetailsQuery([{ number: 1, rollup: false }]).document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})

describe('buildTrackedPullRequestsQuery', () => {
  it('aliases each tracked pull request by position and selects the sweep fields by number, never by label', () => {
    const { document, aliases } = buildTrackedPullRequestsQuery([
      { kind: 'pull-request', number: 7 },
      { kind: 'pull-request', number: 8 },
    ])
    expect(aliases).toEqual([
      { alias: 't0', number: 7 },
      { alias: 't1', number: 8 },
    ])
    const lines = document.split('\n')
    expect(lines.find((line) => line.includes('t0:'))).toContain('t0: pullRequest(number: 7) { number title url body state updatedAt')
    expect(lines.find((line) => line.includes('t1:'))).toContain('headRefOid mergeable')
    expect(document).not.toContain('labels: [')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})
