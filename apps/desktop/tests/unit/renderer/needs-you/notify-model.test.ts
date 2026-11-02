import { describe, expect, it } from 'vitest'
import type { BoardSnapshot, NeedsYouItem } from '@/types/board'
import type { RepoId } from '@/utils/repos'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import { diffNeedsYou, displayNamesOf, needsYouNotification, readableRepoIds } from '@/renderer/needs-you/notify-model'

const A = 'repo-a' as RepoId
const B = 'repo-b' as RepoId

function denial(id: string, overrides: object = {}): NeedsYouItem {
  return { kind: 'stage-denial', repoId: A, repo: 'o/a', number: 552, title: 'Board header', url: null, ticket: null, at: null, matchedRow: null, denial: { id, toolName: 'Bash', inputSummary: 'rm' }, ...overrides } as unknown as NeedsYouItem
}

function snapshotOf(repositories: readonly object[]): BoardSnapshot {
  return { state: { repositories } } as unknown as BoardSnapshot
}

const READABLE = new Set([A, B])

describe('diffNeedsYou', () => {
  it('seeds silently when there is no stored baseline', () => {
    const { baseline, fresh } = diffNeedsYou(null, [denial('d1'), denial('d2')], READABLE)
    expect(fresh).toEqual([])
    expect(baseline).toEqual({ [A]: [dismissKeyOf(denial('d1')), dismissKeyOf(denial('d2'))] })
  })

  it('reports only items whose key was absent from the last read', () => {
    const previous = diffNeedsYou(null, [denial('d1')], READABLE).baseline
    const { fresh } = diffNeedsYou(previous, [denial('d1'), denial('d2')], READABLE)
    expect(fresh.map(dismissKeyOf)).toEqual([dismissKeyOf(denial('d2'))])
  })

  it('reports nothing when the same items come back, as after a relaunch', () => {
    const items = [denial('d1'), denial('d2')]
    const previous = diffNeedsYou(null, items, READABLE).baseline
    expect(diffNeedsYou(previous, items, READABLE).fresh).toEqual([])
  })

  it('reports an item that left and later returned, since its key left the baseline', () => {
    const first = diffNeedsYou(null, [denial('d1')], READABLE).baseline
    const gone = diffNeedsYou(first, [], READABLE)
    expect(gone.baseline).toEqual({})
    expect(diffNeedsYou(gone.baseline, [denial('d1')], READABLE).fresh).toHaveLength(1)
  })

  it('never reports an item the caller already filtered out as dismissed', () => {
    const previous = diffNeedsYou(null, [denial('d1')], READABLE).baseline
    expect(diffNeedsYou(previous, [], READABLE).fresh).toEqual([])
  })

  it('treats a new event on the same ticket as a new item', () => {
    const previous = diffNeedsYou(null, [denial('d1')], READABLE).baseline
    expect(diffNeedsYou(previous, [denial('d1'), denial('d3')], READABLE).fresh).toHaveLength(1)
  })

  it('carries an unreadable repository forward, so recovery never re-notifies', () => {
    const itemB = denial('b1', { repoId: B })
    const previous = diffNeedsYou(null, [denial('d1'), itemB], READABLE).baseline

    const blind = diffNeedsYou(previous, [denial('d1')], new Set([A]))
    expect(blind.fresh).toEqual([])
    expect(blind.baseline[B]).toEqual([dismissKeyOf(itemB)])

    expect(diffNeedsYou(blind.baseline, [denial('d1'), itemB], READABLE).fresh).toEqual([])
  })

  it('carries a repository the snapshot does not mention at all', () => {
    const itemB = denial('b1', { repoId: B })
    const previous = diffNeedsYou(null, [itemB], READABLE).baseline
    expect(diffNeedsYou(previous, [], new Set()).baseline[B]).toEqual([dismissKeyOf(itemB)])
  })

  it('files an item with no repository under the empty key and recomputes it every read', () => {
    const usage = denial('u', { repoId: null, number: null })
    const { baseline } = diffNeedsYou(null, [usage], READABLE)
    expect(baseline['']).toEqual([dismissKeyOf(usage)])
    expect(diffNeedsYou(baseline, [], new Set()).baseline['']).toBeUndefined()
  })
})

describe('needsYouNotification', () => {
  const names = new Map<RepoId, string>([[A, 'port']])

  it('returns null for nothing fresh', () => {
    expect(needsYouNotification([], names)).toBeNull()
  })

  const row = { stageLabel: { key: 'planReview' }, item: { stageHistory: [] } }

  it('names the repository and ticket, leads with the action, and focuses the item', () => {
    const ticket = { kind: 'issue', number: 552, title: 'Board header', url: 'u', pullRequest: null }
    const item = { ...denial('d1'), kind: 'plan-review', ticket, row } as unknown as NeedsYouItem
    expect(needsYouNotification([item], names)).toEqual({ title: 'port · #552 Board header', body: 'Review the plan for #552', focus: dismissKeyOf(item) })
  })

  it('drops the title text when the ticket has none', () => {
    const ticket = { kind: 'issue', number: 552, title: '', url: 'u', pullRequest: null }
    const item = { ...denial('d1'), kind: 'plan-review', ticket, row } as unknown as NeedsYouItem
    expect(needsYouNotification([item], names)?.title).toBe('port · #552')
  })

  it('falls back to the item number without a ticket, and to the app name without anything', () => {
    expect(needsYouNotification([denial('d1')], names)?.title).toBe('port · #552')
    expect(needsYouNotification([denial('u', { repoId: null, number: null })], names)?.title).toBe('port')
  })

  it('collapses several items into one unfocused notification', () => {
    expect(needsYouNotification([denial('d1'), denial('d2'), denial('d3')], names)).toEqual({ title: 'port', body: '3 new items need you', focus: null })
  })

  it('keeps title and body within the 200 characters main accepts', () => {
    const ticket = { kind: 'issue', number: 552, title: 'x'.repeat(500), url: 'u', pullRequest: null }
    const item = { ...denial('d1'), kind: 'stage-question', ticket, sessionKey: 's', permissionId: 'p', questions: [{ header: 'y'.repeat(500) }], at: 't' } as unknown as NeedsYouItem
    const notification = needsYouNotification([item], names)
    expect(notification?.title.length).toBe(200)
    expect(notification?.body.length).toBe(200)
  })
})

describe('snapshot readers', () => {
  const snapshot = snapshotOf([
    { ok: true, repoId: A, displayName: 'port' },
    { ok: false, repoId: B, displayName: 'other', reason: 'github-unavailable' },
  ])

  it('lists only repositories this read answered for', () => {
    expect([...readableRepoIds(snapshot)]).toEqual([A])
  })

  it('names every repository, readable or not', () => {
    expect(displayNamesOf(snapshot).get(B)).toBe('other')
  })
})
