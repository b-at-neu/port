import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { BoardItemRow, NeedsYouItem } from '@/types/board'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'

const REPO = 'repo-a' as RepoId

function base(overrides: Partial<NeedsYouItem> = {}) {
  return { repoId: REPO, repo: 'o/a', number: 554, title: 't', url: null, ticket: null, at: null, matchedRow: null, ...overrides }
}

function rowWith(stageKey: string, history: readonly { key: string; at: string }[], extra: object = {}): BoardItemRow {
  return { stageLabel: { key: stageKey }, item: { stageHistory: history, headRefOid: null, ...extra } } as unknown as BoardItemRow
}

function asItem(value: object): NeedsYouItem {
  return value as NeedsYouItem
}

describe('dismissKeyOf — row kinds', () => {
  it.each(['plan-review', 'ready-to-merge', 'needs-human'] as const)('%s: the same label event keeps its key, a new one earns a new key', (kind) => {
    const stageKey = kind === 'plan-review' ? 'planReview' : kind
    const first = rowWith(stageKey, [{ key: stageKey, at: '2026-01-01T00:00:00Z' }])
    const second = rowWith(stageKey, [{ key: stageKey, at: '2026-01-01T00:00:00Z' }, { key: stageKey, at: '2026-01-02T00:00:00Z' }])
    const again = rowWith(stageKey, [{ key: stageKey, at: '2026-01-01T00:00:00Z' }])
    expect(dismissKeyOf(asItem({ ...base(), kind, row: first }))).toBe(dismissKeyOf(asItem({ ...base(), kind, row: again })))
    expect(dismissKeyOf(asItem({ ...base(), kind, row: first }))).not.toBe(dismissKeyOf(asItem({ ...base(), kind, row: second })))
  })

  it('ignores label events for other stages when timing a plan review', () => {
    const quiet = rowWith('planReview', [{ key: 'planReview', at: '2026-01-01T00:00:00Z' }])
    const noisy = rowWith('planReview', [{ key: 'planReview', at: '2026-01-01T00:00:00Z' }, { key: 'planning', at: '2026-01-03T00:00:00Z' }])
    expect(dismissKeyOf(asItem({ ...base(), kind: 'plan-review', row: quiet }))).toBe(dismissKeyOf(asItem({ ...base(), kind: 'plan-review', row: noisy })))
  })

  it('tells two tickets apart', () => {
    const row = rowWith('planReview', [])
    expect(dismissKeyOf(asItem({ ...base({ number: 1 }), kind: 'plan-review', row }))).not.toBe(dismissKeyOf(asItem({ ...base({ number: 2 }), kind: 'plan-review', row })))
  })
})

describe('dismissKeyOf — stage kinds', () => {
  const interrupted = (interruptedAt: string) => asItem({ ...base(), kind: 'stage-interrupted', interrupted: { id: 'i1', interruptedAt } })

  it('stage-interrupted: a restarted and re-interrupted entry is a new event', () => {
    expect(dismissKeyOf(interrupted('2026-01-01T00:00:00Z'))).toBe(dismissKeyOf(interrupted('2026-01-01T00:00:00Z')))
    expect(dismissKeyOf(interrupted('2026-01-01T00:00:00Z'))).not.toBe(dismissKeyOf(interrupted('2026-01-02T00:00:00Z')))
  })

  const usage = (ids: readonly string[], resetsAt: string | null) => asItem({ ...base({ repoId: null, number: null }), kind: 'usage-limit', entries: ids.map((id) => ({ id })), resetsAt, repoNames: new Map() })

  it('usage-limit: the same set at the same reset keeps its key whatever the order', () => {
    expect(dismissKeyOf(usage(['a', 'b'], 'r1'))).toBe(dismissKeyOf(usage(['b', 'a'], 'r1')))
  })

  it('usage-limit: a new session or a new reset is a new event', () => {
    expect(dismissKeyOf(usage(['a', 'b'], 'r1'))).not.toBe(dismissKeyOf(usage(['a', 'b', 'c'], 'r1')))
    expect(dismissKeyOf(usage(['a', 'b'], 'r1'))).not.toBe(dismissKeyOf(usage(['a', 'b'], 'r2')))
    expect(dismissKeyOf(usage(['a'], null))).not.toBe(dismissKeyOf(usage(['a'], 'r1')))
  })

  it('stage-denial: keyed by the denial itself', () => {
    const denial = (id: string) => asItem({ ...base(), kind: 'stage-denial', denial: { id } })
    expect(dismissKeyOf(denial('d1'))).toBe(dismissKeyOf(denial('d1')))
    expect(dismissKeyOf(denial('d1'))).not.toBe(dismissKeyOf(denial('d2')))
  })

  it('stage-question: keyed by the permission request', () => {
    const question = (permissionId: string) => asItem({ ...base(), kind: 'stage-question', permissionId, sessionKey: 'hosted-1', questions: [] })
    expect(dismissKeyOf(question('p1'))).toBe(dismissKeyOf(question('p1')))
    expect(dismissKeyOf(question('p1'))).not.toBe(dismissKeyOf(question('p2')))
  })

  it('stage-approval: keyed by the permission request, so each pending edit is its own event', () => {
    const approval = (permissionId: string) => asItem({ ...base(), kind: 'stage-approval', permissionId, sessionKey: 'hosted-1', agent: 'impl', toolName: 'Edit', path: '.claude/settings.json' })
    expect(dismissKeyOf(approval('p1'))).toBe('stage-approval:repo-a:554:p1')
    expect(dismissKeyOf(approval('p1'))).not.toBe(dismissKeyOf(approval('p2')))
  })

  it('stage-questions: keyed by the session and when it handed back', () => {
    const handback = (at: string) => asItem({ ...base({ at }), kind: 'stage-questions', sessionKey: 'hosted-1', text: null })
    expect(dismissKeyOf(handback('t1'))).toBe(dismissKeyOf(handback('t1')))
    expect(dismissKeyOf(handback('t1'))).not.toBe(dismissKeyOf(handback('t2')))
  })
})

describe('dismissKeyOf — dispatch and tick kinds', () => {
  it('held: a new reason, head commit or blocker is a new event', () => {
    const held = (reason: string, headRefOid: string | null, blocker: number | null) =>
      asItem({ ...base(), kind: 'held', held: { reason, contention: blocker === null ? null : { blocker } }, owner: 'app', matchedRow: rowWith('x', [], { headRefOid }) })
    expect(dismissKeyOf(held('conflicting', 'abc', null))).toBe(dismissKeyOf(held('conflicting', 'abc', null)))
    expect(dismissKeyOf(held('conflicting', 'abc', null))).not.toBe(dismissKeyOf(held('conflicting', 'def', null)))
    expect(dismissKeyOf(held('contended', 'abc', 38))).not.toBe(dismissKeyOf(held('contended', 'abc', 39)))
    expect(dismissKeyOf(held('conflicting', 'abc', null))).not.toBe(dismissKeyOf(held('cycle-cap', 'abc', null)))
  })

  it('stalled: a fresh stage event after the stall is a new event', () => {
    const stalled = (at: string) => asItem({ ...base(), kind: 'stalled', claim: { class: 'stalled-confirmed' }, matchedRow: rowWith('inProgress', [{ key: 'inProgress', at }]) })
    expect(dismissKeyOf(stalled('t1'))).toBe(dismissKeyOf(stalled('t1')))
    expect(dismissKeyOf(stalled('t1'))).not.toBe(dismissKeyOf(stalled('t2')))
  })

  it('budget: keyed by the note kind and the newest stage event', () => {
    const budget = (kind: string, at: string) => asItem({ ...base(), kind: 'budget', note: { kind }, matchedRow: rowWith('inProgress', [{ key: 'inProgress', at }]) })
    expect(dismissKeyOf(budget('escalated', 't1'))).toBe(dismissKeyOf(budget('escalated', 't1')))
    expect(dismissKeyOf(budget('escalated', 't1'))).not.toBe(dismissKeyOf(budget('escalation-failed', 't1')))
    expect(dismissKeyOf(budget('escalated', 't1'))).not.toBe(dismissKeyOf(budget('escalated', 't2')))
  })

  it('half-labelled: keyed by the shape and the sorted labels', () => {
    const repair = (labels: readonly string[], shape = 'contradictory') => asItem({ ...base(), kind: 'half-labelled', repair: { shape, labels } })
    expect(dismissKeyOf(repair(['a', 'b']))).toBe(dismissKeyOf(repair(['b', 'a'])))
    expect(dismissKeyOf(repair(['a', 'b']))).not.toBe(dismissKeyOf(repair(['a', 'c'])))
    expect(dismissKeyOf(repair(['a', 'b']))).not.toBe(dismissKeyOf(repair(['a', 'b'], 'pr-missing')))
  })
})

describe('dismissKeyOf — dispatch-failed', () => {
  const failed = (detail: string | null, at: string) => asItem({ ...base(), kind: 'dispatch-failed', attempts: 1, record: { agent: 'plan', detail, at } })

  it('stays the same across retries of one error, and changes with a different error', () => {
    expect(dismissKeyOf(failed('boom', '2026-01-01T00:00:00Z'))).toBe(dismissKeyOf(failed('boom', '2026-01-01T00:05:00Z')))
    expect(dismissKeyOf(failed('boom', '2026-01-01T00:00:00Z'))).not.toBe(dismissKeyOf(failed('other', '2026-01-01T00:00:00Z')))
    expect(dismissKeyOf(failed(null, '2026-01-01T00:00:00Z'))).toBe('dispatch-failed:repo-a:554:plan|')
  })
})

describe('dismissKeyOf — shape', () => {
  it('leads with the kind, repository and number', () => {
    const key = dismissKeyOf(asItem({ ...base(), kind: 'stage-denial', denial: { id: 'd1' } }))
    expect(key).toBe('stage-denial:repo-a:554:d1')
  })

  it('leaves the repository and number empty for the collapsed usage-limit line', () => {
    const key = dismissKeyOf(asItem({ ...base({ repoId: null, number: null }), kind: 'usage-limit', entries: [{ id: 'a' }], resetsAt: null, repoNames: new Map() }))
    expect(key.startsWith('usage-limit:::')).toBe(true)
  })
})
