import { describe, expect, it } from 'vitest'
import { historyFor, MAX_ENTRIES, NOT_RECALLING, recallNewer, recallOlder, recallText, recordSent } from './prompt-history'
import type { PromptHistoryStorage } from './prompt-history'
import type { RepoId } from '../../../shared/repos'

const REPO = 'repo-1' as RepoId
const OTHER_REPO = 'repo-2' as RepoId

function fakeStorage(): PromptHistoryStorage {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe('recordSent / historyFor', () => {
  it('prepends newest first', () => {
    const storage = fakeStorage()
    recordSent(REPO, 'first', storage)
    recordSent(REPO, 'second', storage)
    expect(historyFor(REPO, storage)).toEqual(['second', 'first'])
  })

  it('collapses a consecutive duplicate', () => {
    const storage = fakeStorage()
    recordSent(REPO, 'same', storage)
    recordSent(REPO, 'same', storage)
    expect(historyFor(REPO, storage)).toEqual(['same'])
  })

  it('keeps a non-consecutive duplicate', () => {
    const storage = fakeStorage()
    recordSent(REPO, 'a', storage)
    recordSent(REPO, 'b', storage)
    recordSent(REPO, 'a', storage)
    expect(historyFor(REPO, storage)).toEqual(['a', 'b', 'a'])
  })

  it('caps at MAX_ENTRIES', () => {
    const storage = fakeStorage()
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) recordSent(REPO, `prompt-${i}`, storage)
    expect(historyFor(REPO, storage)).toHaveLength(MAX_ENTRIES)
    expect(historyFor(REPO, storage)[0]).toBe(`prompt-${MAX_ENTRIES + 4}`)
  })

  it('keeps each repository separate', () => {
    const storage = fakeStorage()
    recordSent(REPO, 'repo one', storage)
    recordSent(OTHER_REPO, 'repo two', storage)
    expect(historyFor(REPO, storage)).toEqual(['repo one'])
    expect(historyFor(OTHER_REPO, storage)).toEqual(['repo two'])
  })

  it('never records empty text', () => {
    const storage = fakeStorage()
    recordSent(REPO, '', storage)
    expect(historyFor(REPO, storage)).toEqual([])
  })

  it('falls back to empty on malformed storage', () => {
    const storage = fakeStorage()
    storage.setItem('port.promptHistory.v1', 'not json')
    expect(historyFor(REPO, storage)).toEqual([])
  })
})

describe('recall cursor', () => {
  const history = ['third', 'second', 'first']

  it('↑ starts recalling at the newest entry', () => {
    const state = recallOlder(history, NOT_RECALLING)
    expect(recallText(history, state)).toBe('third')
  })

  it('↑ repeatedly walks older', () => {
    let state = recallOlder(history, NOT_RECALLING)
    state = recallOlder(history, state)
    expect(recallText(history, state)).toBe('second')
  })

  it('↑ past the oldest entry stays put', () => {
    let state = NOT_RECALLING
    for (let i = 0; i < 10; i += 1) state = recallOlder(history, state)
    expect(recallText(history, state)).toBe('first')
  })

  it('↓ walks newer, and past the newest returns to not-recalling (an empty draft)', () => {
    let state = recallOlder(history, NOT_RECALLING)
    state = recallNewer(state)
    expect(state).toEqual(NOT_RECALLING)
    expect(recallText(history, state)).toBeNull()
  })
})
