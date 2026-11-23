import { describe, expect, it } from 'vitest'
import { resolveVocabulary, type LabelVocabulary } from '@/utils/labels/vocabulary'
import { graphqlStringLiteral } from '@/main/github/query'
import {
  buildClaimPreflightQuery,
  buildGatePreflightQuery,
  buildIssueDetailsQuery,
  buildIssueSweepQuery,
  buildItemsByNumberQuery,
  buildTrackedIssuesQuery,
} from '@/main/github/tracker/query'

function countOf(document: string, needle: string): number {
  return document.split(needle).length - 1
}

describe('buildIssueSweepQuery', () => {
  it('has one issues connection and no pullRequests connection whatever the label count', () => {
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
      const document = buildIssueSweepQuery(vocabulary, null)
      expect(countOf(document, 'issues(')).toBe(1)
      expect(countOf(document, 'pullRequests(')).toBe(0)
    }
  })

  it('two vocabularies differ only inside the labels list', () => {
    const base = resolveVocabulary({})
    const fewer: LabelVocabulary = { ...base, labels: base.labels.slice(0, 2) }
    const withoutList = (document: string): string => document.replace(/labels: \[[^\]]*\]/g, 'labels: []')
    expect(withoutList(buildIssueSweepQuery(base, null))).toBe(withoutList(buildIssueSweepQuery(fewer, null)))
    expect(buildIssueSweepQuery(base, null)).not.toBe(buildIssueSweepQuery(fewer, null))
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
    const document = buildIssueSweepQuery(vocabulary, null)
    expect(document).toContain('labels: ["ready", "blocked"]')
    expect(document).not.toContain('refresh')
  })

  it('a label name containing a double quote round-trips through the built document', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'weird "quoted" label' } })
    expect(buildIssueSweepQuery(vocabulary, null)).toContain(graphqlStringLiteral('weird "quoted" label'))
  })

  it('every connection carries totalCount, and the sweep connection its pageInfo', () => {
    const document = buildIssueSweepQuery(resolveVocabulary({}), null)
    const lines = document.split('\n').filter((line) => /^\s*(issues|repoLabels):/.test(line))
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toContain('totalCount')
    for (const line of lines.filter((l) => !l.includes('repoLabels'))) expect(line).toContain('pageInfo { hasNextPage endCursor }')
  })

  it('never uses GraphQL search', () => {
    expect(buildIssueSweepQuery(resolveVocabulary({}), null)).not.toContain('search(')
  })

  it('holds none of the heavy fields the detail read owns, and none of the pull request extras', () => {
    const document = buildIssueSweepQuery(resolveVocabulary({}), null)
    for (const heavy of ['reviews', 'comments', 'timelineItems', 'commits', 'statusCheckRollup', 'headRefOid', 'mergeable', 'mergedAt']) expect(document).not.toContain(heavy)
  })

  it('carries the light fields', () => {
    const issues = buildIssueSweepQuery(resolveVocabulary({}), null).split('\n').find((line) => line.includes('issues(')) ?? ''
    for (const field of ['updatedAt', 'assignees(first: 20)', 'labels(first: 100)']) expect(issues).toContain(field)
  })

  it('requests viewer as a top-level field, outside repository', () => {
    const document = buildIssueSweepQuery(resolveVocabulary({}), null)
    const repositoryStart = document.indexOf('repository(owner:')
    const viewerIndex = document.indexOf('viewer { login }')
    expect(viewerIndex).toBeGreaterThan(-1)
    const closeIndex = document.indexOf('\n  }\n', repositoryStart)
    expect(viewerIndex).toBeGreaterThan(closeIndex)
  })

  it('a later page omits repoLabels and viewer and keeps rateLimit', () => {
    const document = buildIssueSweepQuery(resolveVocabulary({}), 'cursor-1')
    expect(document).not.toContain('repoLabels')
    expect(document).not.toContain('viewer')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
    expect(document).toContain('issues(states: OPEN, first: 100')
    expect(document).toContain('after: "cursor-1"')
  })

  it('with no enabled label page one still asks for repoLabels and viewer and no connection', () => {
    const document = buildIssueSweepQuery({ labels: [], disabled: [], problems: [] }, null)
    expect(document).not.toContain('issues(')
    expect(document).toContain('repoLabels')
    expect(document).toContain('viewer { login }')
  })

  it('the first page passes a null cursor and orders oldest first', () => {
    const document = buildIssueSweepQuery(resolveVocabulary({}), null)
    expect(document).toContain('after: null')
    expect(document).toContain('orderBy: {field: CREATED_AT, direction: ASC}')
  })
})

describe('buildIssueDetailsQuery', () => {
  it('emits one aliased issue lookup per item, in order', () => {
    const { document, aliases } = buildIssueDetailsQuery([
      { number: 7, blockerComments: false, closingPullRequests: false },
      { number: 9, blockerComments: false, closingPullRequests: false },
    ])
    expect(aliases).toEqual([
      { alias: 'd0', number: 7, blockerComments: false, closingPullRequests: false },
      { alias: 'd1', number: 9, blockerComments: false, closingPullRequests: false },
    ])
    expect(document).toContain('d0: issue(number: 7)')
    expect(document).toContain('d1: issue(number: 9)')
  })

  it('reads the label timeline and blockedBy, and no pull request fields', () => {
    const { document } = buildIssueDetailsQuery([{ number: 7, blockerComments: false, closingPullRequests: false }])
    const issue = document.split('\n').find((line) => line.includes('d0:')) ?? ''
    expect(issue).toContain('itemTypes: [LABELED_EVENT]')
    expect(issue).toContain('blockedBy(first: 10)')
    expect(issue).not.toContain('reviews')
    expect(issue).not.toContain('comments')
    expect(document).not.toContain('CheckRollupFields')
  })

  it('selects an issue comments connection only when its blockerComments flag is set', () => {
    const { document } = buildIssueDetailsQuery([
      { number: 7, blockerComments: true, closingPullRequests: false },
      { number: 8, blockerComments: false, closingPullRequests: false },
    ])
    const flagged = document.split('\n').find((line) => line.includes('d0:')) ?? ''
    const plain = document.split('\n').find((line) => line.includes('d1:')) ?? ''
    expect(flagged).toContain('comments(last: 10) { nodes { body createdAt url } }')
    expect(plain).not.toContain('comments')
  })

  it('selects closing pull requests only when the flag is set', () => {
    const { document } = buildIssueDetailsQuery([
      { number: 7, blockerComments: false, closingPullRequests: true },
      { number: 8, blockerComments: false, closingPullRequests: false },
    ])
    const lineOf = (alias: string) => document.split('\n').find((line) => line.includes(`${alias}:`)) ?? ''
    expect(lineOf('d0')).toContain('closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state headRefName } }')
    expect(lineOf('d1')).not.toContain('closedByPullRequestsReferences')
  })

  it('carries rateLimit, so every round trip reports its own cost', () => {
    expect(buildIssueDetailsQuery([{ number: 1, blockerComments: false, closingPullRequests: false }]).document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})

describe('buildTrackedIssuesQuery', () => {
  it('aliases each tracked issue by position and selects the sweep fields by number, never by label', () => {
    const { document, aliases } = buildTrackedIssuesQuery([
      { kind: 'issue', number: 7 },
      { kind: 'issue', number: 8 },
    ])
    expect(aliases).toEqual([
      { alias: 't0', number: 7 },
      { alias: 't1', number: 8 },
    ])
    const lines = document.split('\n')
    expect(lines.find((line) => line.includes('t0:'))).toContain('t0: issue(number: 7) { number title url body state updatedAt')
    expect(lines.find((line) => line.includes('t1:'))).toContain('t1: issue(number: 8)')
    expect(document).not.toContain('labels: [')
    expect(document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})

/** Extracts the balanced-brace body of `... on <typeName> { ... }` — a naive regex stops at the
 *  first nested `}`, which falls inside `assignees`'s own braces before the fragment's real close. */
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

describe('buildItemsByNumberQuery', () => {
  it('emits one issueOrPullRequest alias per number', () => {
    const { aliases } = buildItemsByNumberQuery([79, 184])
    expect(aliases).toEqual([
      { alias: 'n0', number: 79 },
      { alias: 'n1', number: 184 },
    ])
  })

  it('requests __typename, and selects mergedAt only inside the PullRequest fragment', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(document).toContain('n0: issueOrPullRequest(number: 1)')
    expect(document).toContain('__typename')
    const issueFragment = extractFragment(document, 'Issue')
    const prFragment = extractFragment(document, 'PullRequest')
    expect(issueFragment).not.toContain('mergedAt')
    expect(prFragment).toContain('mergedAt')
  })

  it('selects headRefName inside the PullRequest fragment only', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(extractFragment(document, 'Issue')).not.toContain('headRefName')
    expect(extractFragment(document, 'PullRequest')).toContain('headRefName')
  })

  it('selects headRefOid inside the PullRequest fragment only', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(extractFragment(document, 'Issue')).not.toContain('headRefOid')
    expect(extractFragment(document, 'PullRequest')).toContain('headRefOid')
  })

  it('selects the author inside the PullRequest fragment only', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(extractFragment(document, 'Issue')).not.toContain('author')
    expect(extractFragment(document, 'PullRequest')).toContain('author { login }')
  })

  it('returns an empty alias list and a still-valid document for no numbers', () => {
    const { document, aliases } = buildItemsByNumberQuery([])
    expect(aliases).toEqual([])
    expect(document).toContain('repository(owner: $owner, name: $name)')
  })

  it('never uses GraphQL search', () => {
    const { document } = buildItemsByNumberQuery([1, 2, 3])
    expect(document).not.toContain('search(')
  })

  it('selects labels inside both the Issue and the PullRequest fragment', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(extractFragment(document, 'Issue')).toContain('labels(first:')
    expect(extractFragment(document, 'PullRequest')).toContain('labels(first:')
  })

  // The write chokepoint's authoritative read needs assignees beside labels, one round trip.
  it('selects assignees inside both the Issue and the PullRequest fragment', () => {
    const { document } = buildItemsByNumberQuery([1])
    expect(extractFragment(document, 'Issue')).toContain('assignees(first:')
    expect(extractFragment(document, 'PullRequest')).toContain('assignees(first:')
  })
})

describe('buildClaimPreflightQuery', () => {
  it('aliases the number as c0 and embeds it as a literal', () => {
    const { document } = buildClaimPreflightQuery(93)
    expect(document).toContain('c0: issueOrPullRequest(number: 93)')
  })

  it('requests labels, assignees, and blockedBy inside the Issue fragment only — never the PullRequest one', () => {
    const { document } = buildClaimPreflightQuery(1)
    const issueFragment = extractFragment(document, 'Issue')
    const prFragment = extractFragment(document, 'PullRequest')
    expect(issueFragment).toContain('labels(first:')
    expect(issueFragment).toContain('assignees(first:')
    expect(issueFragment).toContain('blockedBy(first:')
    expect(prFragment).not.toContain('labels(first:')
    expect(prFragment).not.toContain('assignees(first:')
    expect(prFragment).not.toContain('blockedBy(first:')
  })

  it('blockedBy requests totalCount beside its nodes, for truncation reporting', () => {
    const { document } = buildClaimPreflightQuery(1)
    expect(extractFragment(document, 'Issue')).toMatch(/blockedBy\(first: \d+\) \{ totalCount nodes/)
  })

  it('requests viewer as a top-level field, outside repository', () => {
    const { document } = buildClaimPreflightQuery(1)
    const repositoryStart = document.indexOf('repository(owner:')
    const viewerIndex = document.indexOf('viewer { login }')
    expect(viewerIndex).toBeGreaterThan(-1)
    // The repository block closes with a lone '  }' before viewer appears —
    // asserting viewer is not nested inside it rather than merely present.
    const closeIndex = document.indexOf('\n  }\n', repositoryStart)
    expect(viewerIndex).toBeGreaterThan(closeIndex)
  })

  it('never uses GraphQL search', () => {
    const { document } = buildClaimPreflightQuery(1)
    expect(document).not.toContain('search(')
  })
})

describe('buildGatePreflightQuery', () => {
  it('aliases the number as c0 and embeds it as a literal', () => {
    const { document } = buildGatePreflightQuery(148)
    expect(document).toContain('c0: issueOrPullRequest(number: 148)')
  })

  it('requests body, labels, and assignees inside the Issue fragment only — never the PullRequest one', () => {
    const { document } = buildGatePreflightQuery(1)
    const issueFragment = extractFragment(document, 'Issue')
    const prFragment = extractFragment(document, 'PullRequest')
    expect(issueFragment).toContain('body')
    expect(issueFragment).toContain('labels(first:')
    expect(issueFragment).toContain('assignees(first:')
    expect(prFragment).not.toContain('body')
    expect(prFragment).not.toContain('labels(first:')
    expect(prFragment).not.toContain('assignees(first:')
  })

  it('requests viewer as a top-level field, outside repository', () => {
    const { document } = buildGatePreflightQuery(1)
    const repositoryStart = document.indexOf('repository(owner:')
    const viewerIndex = document.indexOf('viewer { login }')
    expect(viewerIndex).toBeGreaterThan(-1)
    const closeIndex = document.indexOf('\n  }\n', repositoryStart)
    expect(viewerIndex).toBeGreaterThan(closeIndex)
  })

  it('never uses GraphQL search', () => {
    const { document } = buildGatePreflightQuery(1)
    expect(document).not.toContain('search(')
  })
})
