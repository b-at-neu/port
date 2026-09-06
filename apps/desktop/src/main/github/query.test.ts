import { describe, expect, it } from 'vitest'
import { resolveVocabulary, type LabelVocabulary } from '../../shared/labels/vocabulary'
import { buildItemStatesQuery, buildItemsByNumberQuery, buildPipelineQuery, graphqlStringLiteral } from './query'

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

describe('buildPipelineQuery', () => {
  it('emits two aliases per enabled label and none for a disabled one', () => {
    // No shipped label is module-gated any more (#189) — `resolveVocabulary`
    // itself never produces a non-empty `disabled` today (see
    // `vocabulary.test.ts` → "disables nothing"). `disabled` stays a designed
    // extension point (`labels.json`'s own `$comment`), so this builds a
    // `LabelVocabulary` by hand to keep `buildPipelineQuery`'s handling of it
    // under test rather than dropping the case.
    const vocabulary: LabelVocabulary = {
      labels: [
        { key: 'ready', name: 'ready', source: 'default', module: 'core', role: 'trigger' },
        { key: 'blocked', name: 'blocked', source: 'default', module: 'core', role: 'gate' },
      ],
      disabled: ['refreshBranch', 'refreshing'],
      problems: [],
    }
    const { document, aliases } = buildPipelineQuery(vocabulary)

    expect(aliases.length).toBe(vocabulary.labels.length)
    expect(vocabulary.disabled.length).toBeGreaterThan(0)
    for (const disabledKey of vocabulary.disabled) {
      expect(aliases.some((a) => a.key === disabledKey)).toBe(false)
    }
    for (const alias of aliases) {
      expect(document).toContain(`${alias.issueAlias}: issues(`)
      expect(document).toContain(`${alias.prAlias}: pullRequests(`)
    }
  })

  it('aliases are unique, GraphQL-name-shaped, and independent of the label text', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'a name with spaces & symbols!' } })
    const { aliases } = buildPipelineQuery(vocabulary)
    const seen = new Set<string>()
    for (const alias of aliases) {
      for (const name of [alias.issueAlias, alias.prAlias]) {
        expect(seen.has(name)).toBe(false)
        seen.add(name)
        expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).toBe(true)
      }
    }
  })

  it('every connection carries totalCount', () => {
    const vocabulary = resolveVocabulary({})
    const { document } = buildPipelineQuery(vocabulary)
    const connectionLines = document.split('\n').filter((line) => /^\s*(i\d+|p\d+|repoLabels):/.test(line))
    expect(connectionLines.length).toBeGreaterThan(0)
    for (const line of connectionLines) {
      expect(line).toContain('totalCount')
    }
  })

  it('never uses GraphQL search', () => {
    const vocabulary = resolveVocabulary({})
    const { document } = buildPipelineQuery(vocabulary)
    expect(document).not.toContain('search(')
  })

  it('a label name containing a double quote round-trips through the built document', () => {
    const vocabulary = resolveVocabulary({ labels: { ready: 'weird "quoted" label' } })
    const { document } = buildPipelineQuery(vocabulary)
    expect(document).toContain(graphqlStringLiteral('weird "quoted" label'))
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
    const issueFragment = /\.\.\. on Issue \{([^}]*)\}/.exec(document)?.[1] ?? ''
    const prFragment = /\.\.\. on PullRequest \{([^}]*)\}/.exec(document)?.[1] ?? ''
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
})
