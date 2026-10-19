import { describe, expect, it } from 'vitest'
import { resolveVocabulary, type LabelVocabulary } from '@/utils/labels/vocabulary'
import {
  FIRST_SWEEP_PAGE,
  buildClaimPreflightQuery,
  buildGatePreflightQuery,
  buildItemDetailsQuery,
  buildItemStatesQuery,
  buildItemsByNumberQuery,
  buildPipelineQuery,
  graphqlStringLiteral,
} from '@/main/github/query'

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
  it('emits one aliased lookup per item, in order, by kind', () => {
    const { document, aliases } = buildItemDetailsQuery([
      { kind: 'issue', number: 7, rollup: false },
      { kind: 'pull-request', number: 9, rollup: false },
    ])
    expect(aliases).toEqual([
      { alias: 'd0', kind: 'issue', number: 7, rollup: false },
      { alias: 'd1', kind: 'pull-request', number: 9, rollup: false },
    ])
    expect(document).toContain('d0: issue(number: 7)')
    expect(document).toContain('d1: pullRequest(number: 9)')
  })

  it('an issue reads only its label timeline; a pull request also reads reviews and comments', () => {
    const { document } = buildItemDetailsQuery([
      { kind: 'issue', number: 7, rollup: false },
      { kind: 'pull-request', number: 9, rollup: false },
    ])
    const issue = document.split('\n').find((line) => line.includes('d0:')) ?? ''
    const pull = document.split('\n').find((line) => line.includes('d1:')) ?? ''
    expect(issue).toContain('itemTypes: [LABELED_EVENT]')
    expect(issue).not.toContain('reviews')
    expect(pull).toContain('itemTypes: [LABELED_EVENT]')
    expect(pull).toContain('reviews(first: 30)')
    expect(pull).toContain('comments(last: 20)')
  })

  it('spreads CheckRollupFields, and declares it, only when a pull request asks for the rollup', () => {
    const without = buildItemDetailsQuery([{ kind: 'pull-request', number: 9, rollup: false }]).document
    expect(without).not.toContain('CheckRollupFields')
    const withRollup = buildItemDetailsQuery([
      { kind: 'pull-request', number: 9, rollup: false },
      { kind: 'pull-request', number: 10, rollup: true },
    ]).document
    expect(withRollup).toContain('d1: pullRequest(number: 10) {')
    expect(withRollup).toContain('...CheckRollupFields')
    expect(countOf(withRollup, '...CheckRollupFields')).toBe(1)
    expect(withRollup).toContain('fragment CheckRollupFields on PullRequest')
  })

  it('carries rateLimit, so every round trip reports its own cost', () => {
    expect(buildItemDetailsQuery([{ kind: 'issue', number: 1, rollup: false }]).document).toContain('rateLimit { cost remaining resetAt limit }')
  })
})

describe('buildItemStatesQuery', () => {
  it('emits exactly one alias per input item', () => {
    const items = [
      { kind: 'issue' as const, number: 76 },
      { kind: 'pull-request' as const, number: 184 },
    ]
    const { aliases } = buildItemStatesQuery(items)
    expect(aliases).toEqual([
      { alias: 's0', kind: 'issue', number: 76 },
      { alias: 's1', kind: 'pull-request', number: 184 },
    ])
  })

  it('picks the field selector from kind — issue() vs pullRequest(), no mergedAt on an issue alias', () => {
    const { document } = buildItemStatesQuery([
      { kind: 'issue', number: 1 },
      { kind: 'pull-request', number: 2 },
    ])
    expect(document).toContain('s0: issue(number: 1) { number state closedAt url }')
    expect(document).toContain('s1: pullRequest(number: 2) { number state mergedAt closedAt url }')
  })

  it('returns an empty alias list and a still-valid document for no items', () => {
    const { document, aliases } = buildItemStatesQuery([])
    expect(aliases).toEqual([])
    expect(document).toContain('repository(owner: $owner, name: $name)')
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
    const issueFragment = extractFragment(document, 'Issue')
    const prFragment = extractFragment(document, 'PullRequest')
    expect(issueFragment).toContain('labels(first:')
    expect(prFragment).toContain('labels(first:')
  })

  // The write chokepoint's authoritative read needs assignees beside labels, one round trip.
  it('selects assignees inside both the Issue and the PullRequest fragment', () => {
    const { document } = buildItemsByNumberQuery([1])
    const issueFragment = extractFragment(document, 'Issue')
    const prFragment = extractFragment(document, 'PullRequest')
    expect(issueFragment).toContain('assignees(first:')
    expect(prFragment).toContain('assignees(first:')
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
    const issueFragment = extractFragment(document, 'Issue')
    expect(issueFragment).toMatch(/blockedBy\(first: \d+\) \{ totalCount nodes/)
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
