import { describe, expect, it } from 'vitest'
import { HISTORY_CAP, emptyFile, parseFile, prune, seedFrom, trackedOf, transition, viewOf, withItem } from '@/main/pipeline-state/model'
import type { RepoRecord, StoredItem, TransitionInput } from '@/types/pipeline-state'
import { reconciledItem, repositoryState } from '../../../fixtures/board-state'

const AT = '2026-01-01T00:00:00.000Z'

function stored(overrides: Partial<StoredItem> = {}): StoredItem {
  return { kind: 'issue', number: 7, keys: ['ready'], marked: true, autoPlan: false, claimedAt: null, reviewCycles: 0, history: [], updatedAt: AT, ...overrides }
}

function recordOf(...items: StoredItem[]): RepoRecord {
  return items.reduce((record, item) => withItem(record, item), { seededAt: AT, heldBy: null, items: {} } as RepoRecord)
}

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
  return { add: [], remove: [], expect: { present: [], absent: [] }, action: 'test', at: AT, actor: null, ...overrides }
}

describe('parseFile', () => {
  it.each([undefined, null, '{', [], { version: 1 }, { version: 1, repositories: [] }, { version: 2, repositories: {} }])('reads %j as empty', (value) => {
    expect(parseFile(value)).toEqual(emptyFile())
  })

  it('keeps a good repository and drops a bad item, never the whole repository', () => {
    const good = stored()
    const file = parseFile({
      version: 1,
      repositories: {
        'repo-a': { seededAt: AT, heldBy: null, items: { 'issue:7': good, 'issue:8': { kind: 'issue', number: 8 }, 'issue:9': { ...good, number: 9, keys: ['not-a-key'] } } },
        'repo-b': 'junk',
      },
    })
    expect(Object.keys(file.repositories)).toEqual(['repo-a'])
    expect(Object.keys(file.repositories['repo-a']?.items ?? {})).toEqual(['issue:7'])
  })
})

describe('seedFrom', () => {
  it('stores one item per reconciled item, from what the board showed', () => {
    const state = repositoryState([
      reconciledItem({
        number: 5,
        matchedKeys: ['marker', 'autoPlan', 'inProgress'],
        stageHistory: [
          { key: 'ready', actor: 'op', at: '2026-01-01T00:00:00Z' },
          { key: 'inProgress', actor: 'op', at: '2026-01-02T00:00:00Z' },
        ],
      }),
      reconciledItem({ number: 6, kind: 'pull-request', matchedKeys: ['approved'], reviewCycleCount: 3 }),
    ])
    const record = seedFrom(state, AT)
    expect(record.heldBy).toBeNull()
    expect(record.items['issue:5']).toMatchObject({ keys: ['inProgress'], marked: true, autoPlan: true, claimedAt: '2026-01-02T00:00:00Z', reviewCycles: 0 })
    expect(record.items['issue:5']?.history.map((row) => row.add)).toEqual([['ready'], ['inProgress']])
    expect(record.items['pull-request:6']).toMatchObject({ keys: ['approved'], marked: false, reviewCycles: 3 })
  })
})

describe('transition', () => {
  it('refuses when an expected key is not stored', () => {
    expect(transition(recordOf(stored()), { kind: 'issue', number: 7 }, input({ expect: { present: ['planApproved'], absent: [] } }))).toEqual({ ok: false, reason: 'precondition-failed' })
  })

  it('refuses when an expected-absent key is stored', () => {
    expect(transition(recordOf(stored()), { kind: 'issue', number: 7 }, input({ expect: { present: [], absent: ['ready'] } }))).toEqual({ ok: false, reason: 'precondition-failed' })
  })

  it('refuses an untracked item whenever it expects something present', () => {
    expect(transition(recordOf(), { kind: 'issue', number: 7 }, input({ expect: { present: ['ready'], absent: [] } }))).toEqual({ ok: false, reason: 'precondition-failed' })
  })

  it('creates an untracked item when nothing is expected present, so Work on can claim it', () => {
    const next = transition(recordOf(), { kind: 'issue', number: 9 }, input({ add: ['marker', 'ready'], expect: { present: [], absent: ['marker'] } }))
    expect(next).toMatchObject({ ok: true, changed: true, item: { number: 9, keys: ['ready'], marked: true } })
  })

  it('swaps keys, toggles the markers, and stamps claimedAt when an in-flight key is added', () => {
    const next = transition(recordOf(stored({ keys: ['planApproved'] })), { kind: 'issue', number: 7 }, input({ add: ['inProgress', 'autoPlan'], remove: ['planApproved', 'marker'], action: 'stage-claim' }))
    expect(next).toMatchObject({ ok: true, changed: true, item: { keys: ['inProgress'], marked: false, autoPlan: true, claimedAt: AT } })
    if (next.ok) expect(next.item.history.at(-1)).toEqual({ at: AT, action: 'stage-claim', add: ['inProgress', 'autoPlan'], remove: ['planApproved', 'marker'], actor: null })
  })

  it('reports no change, and adds no history row, for a transition that lands where it already is', () => {
    const item = stored()
    expect(transition(recordOf(item), { kind: 'issue', number: 7 }, input({ add: ['ready'] }))).toEqual({ ok: true, item, changed: false })
  })

  it('bounds the history', () => {
    let record = recordOf(stored())
    for (let i = 0; i < HISTORY_CAP + 5; i++) {
      const result = transition(record, { kind: 'issue', number: 7 }, input({ add: i % 2 === 0 ? ['blocked'] : [], remove: i % 2 === 0 ? [] : ['blocked'], action: `n${String(i)}` }))
      if (result.ok) record = withItem(record, result.item)
    }
    expect(record.items['issue:7']?.history).toHaveLength(HISTORY_CAP)
  })

  it.each([
    ['stage-handback-approved', 1],
    ['stage-handback-needs-revision', 1],
    ['stage-handback-checks-pending', 1],
    ['stage-handback-rebase-required', 0],
    ['stage-handback-head-moved', 0],
    ['stage-claim', 0],
  ])('%s counts %i review cycles', (action, cycles) => {
    const record = recordOf(stored({ kind: 'pull-request', keys: ['reviewing'], reviewCycles: 2 }))
    const result = transition(record, { kind: 'pull-request', number: 7 }, input({ add: ['approved'], remove: ['reviewing'], action }))
    expect(result).toMatchObject({ ok: true, item: { reviewCycles: 2 + cycles } })
  })
})

describe('prune, view and tracked', () => {
  it('drops closed numbers and keeps the record identity when nothing is closed', () => {
    const record = recordOf(stored({ number: 1 }), stored({ number: 2 }))
    expect(prune(record, [])).toBe(record)
    expect(Object.keys(prune(record, [1]).items)).toEqual(['issue:2'])
  })

  it('reads labels for an unseeded or terminal-held repository, the store otherwise', () => {
    const record = recordOf(stored())
    expect(viewOf(undefined)).toEqual({ kind: 'labels' })
    expect(viewOf({ ...record, heldBy: 'terminal' })).toEqual({ kind: 'labels' })
    expect(viewOf(record)).toEqual({ kind: 'store', items: [stored()] })
    expect(trackedOf({ ...record, heldBy: 'terminal' })).toBeNull()
    expect(trackedOf(record)).toEqual([{ kind: 'issue', number: 7, keys: ['marker', 'ready'] }])
  })
})
