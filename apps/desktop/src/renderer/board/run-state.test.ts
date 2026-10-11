// Covers the per-repository run-state row's pure copy functions (#314,
// #316) — the row and its buttons live in `shell/sidebar-pipelines.tsx` now,
// driven by `shell/run-state-command.ts`'s mutation.
import { describe, expect, it } from 'vitest'
import type { RepoId } from '../../../shared/repos'
import type { RepoRunState, RunStatesSnapshot } from '../../../shared/dispatch/types'
import { runStateLineCopy, runStateResultNote } from './run-state'

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
    expect(line).toContain('Paused since')
    expect(line).toContain('nothing dispatches')
  })

  it('reads the new-repository variant when since is null', () => {
    expect(runStateLineCopy(runState({ state: 'paused', since: null }), LOADED)).toBe('Paused — press Run to start dispatching')
  })

  it('reads as reading the saved state before load() resolves, regardless of this repository\'s own state', () => {
    expect(runStateLineCopy(runState({ state: 'dispatching', since: '2026-01-01T00:00:00Z' }), { kind: 'unread' })).toBe('Paused — reading the saved pipeline state…')
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
    expect(note).toContain("It's still paused")
  })

  it('names the message for a run or drain refused as unreadable', () => {
    const note = runStateResultNote({ ok: false, command: 'run', repoId: REPO_ID, reason: 'unreadable', message: "can't read", path: '/userData/dispatch.json' })
    expect(note).toContain('Stays paused')
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

  it('names the since instant when run is refused by a terminal cockpit', () => {
    const note = runStateResultNote({ ok: false, command: 'run', repoId: REPO_ID, reason: 'terminal-owned', since: '2026-01-01T14:02:00.000Z' })
    expect(note).toContain('terminal cockpit')
    expect(note).toContain('2026-01-01T14:02:00.000Z')
  })

  it('names the message when run is refused for an unreadable ownership record', () => {
    const note = runStateResultNote({ ok: false, command: 'run', repoId: REPO_ID, reason: 'ownership-unreadable', message: 'bad json' })
    expect(note).toContain('bad json')
  })

  it('names the since instant when drain is refused by a terminal cockpit', () => {
    const note = runStateResultNote({ ok: false, command: 'drain', repoId: REPO_ID, reason: 'terminal-owned', since: '2026-01-01T14:02:00.000Z' })
    expect(note).toContain('terminal cockpit')
  })

  it('says nothing for a successful take-over', () => {
    expect(runStateResultNote({ ok: true, command: 'take-over', repoId: REPO_ID, runState: runState({ state: 'dispatching' }) })).toBeNull()
  })

  it('names the path and message for a take-over that fails to write', () => {
    const note = runStateResultNote({ ok: false, command: 'take-over', repoId: REPO_ID, reason: 'unwritable', message: 'disk full', path: '/repo/.agents/cockpit.json' })
    expect(note).toContain('/repo/.agents/cockpit.json')
    expect(note).toContain('disk full')
  })
})
