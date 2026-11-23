import { describe, expect, it } from 'vitest'
import {
  allDisplayNames,
  displayKeysOf,
  displayNamesOf,
  displayStateOf,
  issueNumberOfBranch,
  legacyKeysOf,
  linkedIssueOf,
  linkedPullRequestOf,
  mergedKeysOf,
  mirrorDiff,
  needsYouOf,
} from '@/main/pipeline/state/mirror'
import type { StoredHistoryRow, StoredItem } from '@/types/pipeline-state'
import { resolveDisplayVocabulary } from '@/utils/labels/display'
import type { LabelKey } from '@/utils/labels/vocabulary'

function stored(keys: readonly LabelKey[], overrides: Partial<StoredItem> = {}): StoredItem {
  return { kind: 'issue', number: 7, keys, marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: '2026-01-01T00:00:00.000Z', issue: null, mirrorFailure: null, ...overrides }
}

function row(add: readonly LabelKey[], remove: readonly LabelKey[] = []): StoredHistoryRow {
  return { at: 't', action: 'a', add, remove, actor: null }
}

describe('displayStateOf', () => {
  it.each([
    ['ready', 'planning'],
    ['planning', 'planning'],
    ['planReview', 'planning'],
    ['planChangesRequested', 'planning'],
    ['planApproved', 'implementing'],
    ['inProgress', 'implementing'],
    ['blocked', 'implementing'],
    ['readyForReview', 'reviewing'],
    ['reviewing', 'reviewing'],
    ['needsRevision', 'revising'],
    ['revising', 'revising'],
    ['refreshBranch', 'revising'],
    ['refreshing', 'revising'],
    ['approved', 'approved'],
  ] as const)('%s shows %s', (key, state) => {
    expect(displayStateOf(stored([key]))).toBe(state)
  })

  it('shows nothing for an item holding no mapped key', () => {
    expect(displayStateOf(stored([]))).toBeNull()
    expect(displayStateOf(stored(['prOpened']))).toBeNull()
  })

  it('lets a branch refresh beside approved win as revising', () => {
    expect(displayStateOf(stored(['approved', 'refreshBranch']))).toBe('revising')
    expect(displayStateOf(stored(['approved', 'refreshing']))).toBe('revising')
  })

  it('recovers the state needsHuman interrupted from the newest history row that added a mapped key', () => {
    const history = [row(['planning']), row(['reviewing'], ['planning']), row(['needsHuman'], ['reviewing'])]
    expect(displayStateOf(stored(['needsHuman'], { kind: 'pull-request', history }))).toBe('reviewing')
    expect(displayStateOf(stored(['needsHuman'], { history: [row(['ready']), row(['inProgress'], ['ready']), row(['needsHuman'])] }))).toBe('implementing')
  })

  it('falls back to planning for an issue and reviewing for a pull request when history names no state', () => {
    expect(displayStateOf(stored(['needsHuman']))).toBe('planning')
    expect(displayStateOf(stored(['needsHuman'], { kind: 'pull-request' }))).toBe('reviewing')
  })
})

describe('needsYouOf', () => {
  it.each(['planReview', 'blocked', 'needsHuman'] as const)('%s needs a person', (key) => {
    expect(needsYouOf(stored([key]))).toBe(true)
  })

  it('does not for an in-flight or terminal key', () => {
    for (const key of ['planning', 'inProgress', 'reviewing', 'approved', 'readyForReview'] as const) expect(needsYouOf(stored([key]))).toBe(false)
  })
})

describe('displayKeysOf', () => {
  it('always includes port, with the one state', () => {
    expect(displayKeysOf(stored(['inProgress']), null)).toEqual(['port', 'implementing'])
  })

  it('puts needs you on top of the state, never in place of it', () => {
    expect(displayKeysOf(stored(['planReview']), null)).toEqual(['port', 'planning', 'needsYou'])
    expect(displayKeysOf(stored(['blocked']), null)).toEqual(['port', 'implementing', 'needsYou'])
  })

  it('gives an item with no mapped key port alone', () => {
    expect(displayKeysOf(stored([]), null)).toEqual(['port'])
  })

  it('shows an issue at prOpened its pull request\'s state, and implementing with no pull request stored', () => {
    const issue = stored(['prOpened'])
    expect(displayKeysOf(issue, stored(['needsRevision'], { kind: 'pull-request', number: 9, issue: 7 }))).toEqual(['port', 'revising'])
    expect(displayKeysOf(issue, null)).toEqual(['port', 'implementing'])
  })

  it('shows needs you on the ticket when either it or its pull request needs a person', () => {
    const escalated = stored(['needsHuman'], { kind: 'pull-request', number: 9, issue: 7, history: [row(['reviewing'])] })
    expect(displayKeysOf(stored(['prOpened']), escalated)).toEqual(['port', 'reviewing', 'needsYou'])
    expect(displayKeysOf(stored(['prOpened', 'needsHuman']), stored(['reviewing'], { kind: 'pull-request', number: 9, issue: 7 }))).toEqual(['port', 'reviewing', 'needsYou'])
  })

  it('shows a pull request its own state', () => {
    expect(displayKeysOf(stored(['approved'], { kind: 'pull-request', number: 9, issue: 7 }), null)).toEqual(['port', 'approved'])
  })
})

describe('legacyKeysOf and mergedKeysOf', () => {
  it('writes the store\'s own keys, markers included', () => {
    expect(legacyKeysOf(stored(['planApproved'], { autoPlan: true }))).toEqual(['marker', 'autoPlan', 'planApproved'])
  })

  it('puts approved in place of every in-flight or trigger key, keeping markers and gates', () => {
    expect(mergedKeysOf(stored(['reviewing'], { kind: 'pull-request' }))).toEqual(['marker', 'approved'])
    expect(mergedKeysOf(stored(['readyForReview', 'needsHuman'], { kind: 'pull-request' }))).toEqual(['marker', 'needsHuman', 'approved'])
    expect(mergedKeysOf(stored(['approved'], { kind: 'pull-request' }))).toEqual(['marker', 'approved'])
  })
})

describe('linkedPullRequestOf and linkedIssueOf', () => {
  const older = stored(['readyForReview'], { kind: 'pull-request', number: 8, issue: 7, updatedAt: '2026-01-01T00:00:00.000Z' })
  const newer = stored(['readyForReview'], { kind: 'pull-request', number: 9, issue: 7, updatedAt: '2026-01-02T00:00:00.000Z' })
  const other = stored(['readyForReview'], { kind: 'pull-request', number: 10, issue: 3 })

  it('picks the newest stored pull request naming the issue', () => {
    expect(linkedPullRequestOf([older, newer, other], 7)).toBe(newer)
    expect(linkedPullRequestOf([other], 7)).toBeNull()
  })

  it('finds the ticket only while it still holds prOpened', () => {
    expect(linkedIssueOf([stored(['prOpened'])], newer)?.number).toBe(7)
    expect(linkedIssueOf([stored(['approved'])], newer)).toBeNull()
    expect(linkedIssueOf([stored(['prOpened'])], stored([], { kind: 'pull-request', issue: null }))).toBeNull()
  })
})

describe('issueNumberOfBranch', () => {
  it.each([
    ['751-one-way-display-mirror', 751],
    ['7-x', 7],
  ])('%s → %i', (branch, number) => {
    expect(issueNumberOfBranch(branch)).toBe(number)
  })

  it.each([null, '', 'main', 'feature-12-thing', 'v2-x', '12'])('%s names no ticket', (branch) => {
    expect(issueNumberOfBranch(branch)).toBeNull()
  })
})

describe('mirrorDiff', () => {
  const all = ['port', 'needs you', 'planning', 'implementing', 'reviewing', 'revising', 'approved']

  it('adds what is missing and removes every other vocabulary label that is present', () => {
    expect(mirrorDiff(['port', 'implementing'], all, ['planning', 'approved'])).toEqual({ addNames: ['port', 'implementing'], removeNames: ['planning', 'approved'] })
  })

  it('writes nothing when the labels already match', () => {
    expect(mirrorDiff(['port', 'planning'], all, ['port', 'planning'])).toEqual({ addNames: [], removeNames: [] })
  })

  it('compares case-insensitively and writes the configured casing', () => {
    expect(mirrorDiff(['Port', 'Planning'], all, ['port', 'PLANNING', 'Approved'])).toEqual({ addNames: [], removeNames: ['approved'] })
    expect(mirrorDiff(['Port'], all, [])).toEqual({ addNames: ['Port'], removeNames: [] })
  })

  it('never touches a label outside the vocabulary', () => {
    expect(mirrorDiff(['port'], all, ['port', 'bug', 'good first issue'])).toEqual({ addNames: [], removeNames: [] })
  })
})

describe('display names', () => {
  const vocabulary = resolveDisplayVocabulary({ labels: { needsYou: 'help' }, states: { implementing: 'building' } })

  it('resolves keys through the configured names', () => {
    expect(displayNamesOf(vocabulary, ['port', 'implementing', 'needsYou'])).toEqual(['port', 'building', 'help'])
    expect(allDisplayNames(vocabulary)).toEqual(['port', 'help', 'planning', 'building', 'reviewing', 'revising', 'approved'])
  })
})
