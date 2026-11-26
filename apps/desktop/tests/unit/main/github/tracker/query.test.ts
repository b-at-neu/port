import { describe, expect, it } from 'vitest'
import { resolveVocabulary } from '@/utils/labels/vocabulary'
import { FIRST_SWEEP_PAGE } from '@/main/github/query'
import { buildClaimPreflightQuery, buildGatePreflightQuery, buildIssueDetailsQuery, buildIssueSweepQuery, buildItemsByNumberQuery, buildTrackedIssuesQuery } from '@/main/github/tracker/query'

/** The balanced-brace body of `... on <typeName> { ... }` — a regex would stop at the first nested `}`. */
function extractFragment(document: string, typeName: string): string {
  const start = document.indexOf(`... on ${typeName} {`)
  if (start === -1) return ''
  let depth = 0
  let i = document.indexOf('{', start)
  const bodyStart = i + 1
  for (; i < document.length; i++) {
    if (document[i] === '{') depth++
    else if (document[i] === '}') {
      depth--
      if (depth === 0) return document.slice(bodyStart, i)
    }
  }
  return document.slice(bodyStart)
}

const builders = [
  { name: 'items by number', build: () => buildItemsByNumberQuery([1]).document, issueOnly: [], bothFragments: ['labels(first:', 'assignees(first:'], pullOnly: ['mergedAt', 'headRefName', 'headRefOid', 'author { login }'], viewer: false },
  { name: 'claim preflight', build: () => buildClaimPreflightQuery(1).document, issueOnly: ['labels(first:', 'assignees(first:', 'blockedBy(first:'], bothFragments: [], pullOnly: [], viewer: true },
  { name: 'gate preflight', build: () => buildGatePreflightQuery(1).document, issueOnly: ['body', 'assignees(first:'], bothFragments: [], pullOnly: [], viewer: true },
] as const

describe('tracker point-read documents', () => {
  it.each(builders)('$name places each field in the right fragment and never searches', ({ build, issueOnly, bothFragments, pullOnly, viewer }) => {
    const document = build()
    const issue = extractFragment(document, 'Issue')
    const pull = extractFragment(document, 'PullRequest')
    for (const field of issueOnly) {
      expect(issue).toContain(field)
      expect(pull).not.toContain(field)
    }
    for (const field of bothFragments) {
      expect(issue).toContain(field)
      expect(pull).toContain(field)
    }
    for (const field of pullOnly) {
      expect(pull).toContain(field)
      expect(issue).not.toContain(field)
    }
    expect(document).not.toContain('search(')
    if (viewer) expect(document.indexOf('viewer { login }')).toBeGreaterThan(document.indexOf('\n  }\n', document.indexOf('repository(owner:')))
  })

  it.each([
    { name: 'claim preflight', build: () => buildClaimPreflightQuery(93).document, expected: 'c0: issueOrPullRequest(number: 93)' },
    { name: 'gate preflight', build: () => buildGatePreflightQuery(148).document, expected: 'c0: issueOrPullRequest(number: 148)' },
  ])('$name aliases the number as c0', ({ build, expected }) => {
    expect(build()).toContain(expected)
  })

  it('items by number emits one alias per number, in order, and a valid document for none', () => {
    expect(buildItemsByNumberQuery([79, 184]).aliases).toEqual([
      { alias: 'n0', number: 79 },
      { alias: 'n1', number: 184 },
    ])
    const empty = buildItemsByNumberQuery([])
    expect(empty.aliases).toEqual([])
    expect(empty.document).toContain('repository(owner: $owner, name: $name)')
  })

  it('blockedBy requests totalCount beside its nodes, for truncation reporting', () => {
    expect(extractFragment(buildClaimPreflightQuery(1).document, 'Issue')).toMatch(/blockedBy\(first: \d+\) \{ totalCount nodes/)
  })
})

const lineOf = (document: string, alias: string) => document.split('\n').find((line) => line.includes(`${alias}:`)) ?? ''

describe('buildIssueSweepQuery', () => {
  const vocabulary = resolveVocabulary({})

  it('has one issues connection and no pull request field', () => {
    const document = buildIssueSweepQuery(vocabulary, FIRST_SWEEP_PAGE)
    expect(document.split('issues(')).toHaveLength(2)
    for (const absent of ['pullRequests', 'integrationHistory', 'headRefOid', 'mergedAt']) expect(document).not.toContain(absent)
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })

  it('carries the repository label list and the viewer on page one only', () => {
    const first = buildIssueSweepQuery(vocabulary, FIRST_SWEEP_PAGE)
    expect(first).toContain('repoLabels: labels(first: 100)')
    expect(first).toContain('viewer { login }')
    const later = buildIssueSweepQuery(vocabulary, { connection: true, after: 'cursor-1' })
    expect(later).toContain('after: "cursor-1"')
    expect(later).not.toContain('repoLabels')
    expect(later).not.toContain('viewer')
  })

  it('with no connection asked, page one is the label list and viewer alone', () => {
    const document = buildIssueSweepQuery(vocabulary, { connection: false, after: null })
    expect(document).not.toContain('issues(')
    expect(document).toContain('repoLabels')
    expect(document).toContain('viewer { login }')
  })
})

describe('buildTrackedIssuesQuery', () => {
  it('aliases each tracked issue by position and selects by number, never by label', () => {
    const { document, aliases } = buildTrackedIssuesQuery([3, 8])
    expect(aliases).toEqual([
      { alias: 't0', number: 3 },
      { alias: 't1', number: 8 },
    ])
    expect(lineOf(document, 't0')).toContain('t0: issue(number: 3) {')
    expect(lineOf(document, 't1')).toContain('t1: issue(number: 8) {')
    expect(document).not.toContain('labels: [')
  })
})

describe('buildIssueDetailsQuery', () => {
  const { document, aliases } = buildIssueDetailsQuery([
    { number: 1, blockerComments: false, closingPullRequests: false },
    { number: 2, blockerComments: true, closingPullRequests: false },
    { number: 3, blockerComments: false, closingPullRequests: true },
  ])

  it('emits one aliased lookup per issue, in order', () => {
    expect(aliases).toEqual([
      { alias: 'd0', number: 1 },
      { alias: 'd1', number: 2 },
      { alias: 'd2', number: 3 },
    ])
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })

  it.each([
    ['d0', false, false],
    ['d1', true, false],
    ['d2', false, true],
  ])('%s selects comments %s and closing pull requests %s, and always the timeline and blockers', (alias, comments, closing) => {
    const line = lineOf(document, alias)
    expect(line.includes('comments(last: 10)')).toBe(comments)
    expect(line.includes('closedByPullRequestsReferences')).toBe(closing)
    expect(line).toContain('timelineItems')
    expect(line).toContain('blockedBy(')
  })
})
