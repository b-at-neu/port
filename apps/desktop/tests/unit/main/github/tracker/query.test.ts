import { describe, expect, it } from 'vitest'
import { buildClaimPreflightQuery, buildGatePreflightQuery, buildItemsByNumberQuery } from '@/main/github/tracker/query'

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
