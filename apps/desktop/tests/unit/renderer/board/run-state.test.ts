// Covers the per-repository run-state row's pure copy functions.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '@/utils/repos'
import type { RepoRunState, RunStatesSnapshot } from '@/types/dispatch'
import { runStateLineCopy, runStateResultNote, undoCommandFor } from '@/renderer/board/run-state'

const REPO_ID = 'repo-a' as RepoId

function runState(overrides: Partial<RepoRunState> = {}): RepoRunState {
  return { repoId: REPO_ID, state: 'paused', since: null, ...overrides }
}

const LOADED: RunStatesSnapshot['store'] = { kind: 'loaded' }

describe('runStateLineCopy', () => {
  it('names the since instant for a running repository', () => {
    expect(runStateLineCopy(runState({ state: 'dispatching', since: '2026-01-01T14:02:00.000Z' }), LOADED)).toContain('Running since')
  })

  it('names the since instant for a draining repository, with the finish-in-flight note', () => {
    const line = runStateLineCopy(runState({ state: 'draining', since: '2026-01-01T14:02:00.000Z' }), LOADED)
    expect(line).toContain('Draining since')
    expect(line).toContain('work in progress finishes, nothing new starts')
  })

  it('names the since instant for a paused repository', () => {
    const line = runStateLineCopy(runState({ state: 'paused', since: '2026-01-01T14:02:00.000Z' }), LOADED)
    expect(line).toContain('Stopped since')
    expect(line).toContain('nothing dispatches')
  })

  it('reads the new-repository variant when since is null', () => {
    expect(runStateLineCopy(runState({ state: 'paused', since: null }), LOADED)).not.toContain('since')
  })

  it('reads as reading the saved state before load() resolves, regardless of this repository\'s own state', () => {
    const line = runStateLineCopy(runState({ state: 'dispatching', since: '2026-01-01T00:00:00Z' }), { kind: 'unread' })
    expect(line).not.toContain('Running')
    expect(line).not.toContain('since')
  })

  it('names the message when the store cannot be read, regardless of this repository\'s own state', () => {
    const line = runStateLineCopy(runState(), { kind: 'unreadable', message: 'boom', path: '/dispatch.json' })
    expect(line).toContain("can't be read (boom)")
  })
})

describe('runStateResultNote', () => {
  it('says nothing for an ordinary successful run', () => {
    expect(runStateResultNote({ ok: true, command: 'run', repoId: REPO_ID, runState: runState({ state: 'dispatching' }) })).toBeNull()
  })

  it('names the path and message for a run refused as unwritable', () => {
    const note = runStateResultNote({ ok: false, command: 'run', repoId: REPO_ID, reason: 'unwritable', message: 'disk full', path: '/userData/dispatch.json' })
    expect(note).toContain('/userData/dispatch.json')
    expect(note).toContain('disk full')
    expect(note).toContain("It's still stopped")
  })

  it('names the message for a run or drain refused as unreadable', () => {
    const note = runStateResultNote({ ok: false, command: 'run', repoId: REPO_ID, reason: 'unreadable', message: "can't read", path: '/userData/dispatch.json' })
    expect(note).toContain('Stays stopped')
    expect(note).toContain("can't read")
  })

  it('says nothing for an ordinary persisted drain', () => {
    expect(runStateResultNote({ ok: true, command: 'drain', repoId: REPO_ID, runState: runState({ state: 'draining' }), persisted: true })).toBeNull()
  })

  it('warns once a drain write fails to persist, since the gate still closed in memory', () => {
    const note = runStateResultNote({ ok: true, command: 'drain', repoId: REPO_ID, runState: runState({ state: 'draining' }), persisted: false })
    expect(note).toBe("Draining, but it wasn't saved to disk, so it won't survive a restart.")
  })

  it('says nothing for a pause — its own report renders separately', () => {
    expect(runStateResultNote({ ok: true, command: 'pause', repoId: REPO_ID, runState: runState(), report: { kind: 'completed', items: [] }, released: true })).toBeNull()
  })

  it.each(['run', 'drain'] as const)('names the message when %s is refused for an unreadable ownership record', (command) => {
    const note = runStateResultNote({ ok: false, command, repoId: REPO_ID, reason: 'ownership-unreadable', message: 'bad json' })
    expect(note).toContain('bad json')
  })
})

describe('undoCommandFor', () => {
  it.each([
    ['dispatching', 'run', null],
    ['draining', 'run', 'drain'],
    ['paused', 'run', 'pause'],
    [null, 'run', null],
    ['dispatching', 'drain', 'run'],
    ['draining', 'drain', null],
    ['paused', 'drain', null],
    [null, 'drain', null],
  ] as const)('after %s then %s it returns %s', (prior, command, expected) => {
    expect(undoCommandFor(prior, command)).toBe(expected)
  })
})
