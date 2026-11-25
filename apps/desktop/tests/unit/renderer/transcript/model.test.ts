import { describe, expect, it } from 'vitest'
import { backTarget, ticketOf, transcriptPageOf } from '@/renderer/transcript/model'
import type { FileReady, FileTranscript } from '@/renderer/data/transcript-model'
import type { BoardItemRef } from '@/types/router'
import type { RepoId } from '@/utils/repos'
import type { RepositoryState } from '@/types/state'
import { boardSnapshot, reconciledItem, repositoryState } from '../../../support/board-snapshot'

const REPO = 'repo-a' as RepoId

function ready(entryCount: number): FileReady {
  return {
    kind: 'file',
    status: 'ready',
    tailId: 't',
    source: { sessionId: 's', agentId: null, sizeBytes: 1, modifiedAt: '2026-01-01T00:00:00Z', malformedLines: 0 },
    entries: Array.from({ length: entryCount }, () => ({})) as unknown as FileReady['entries'],
    following: true,
    failure: null,
    truncatedNote: false,
    hasMore: false,
  } as FileReady
}

describe('transcriptPageOf', () => {
  const openFailed: FileTranscript = { kind: 'file', status: 'open-failed', failure: { kind: 'not-found', message: '', path: '/x' } }

  it.each([
    ['loading', { status: 'loading' as const }, 'loading', null],
    ['unreachable', { status: 'unreachable' as const }, 'error', 'unreachable'],
    ['open-failed', openFailed, 'error', 'open'],
    ['ready with no entries', ready(0), 'empty', null],
    ['ready with entries', ready(2), 'ready', null],
  ])('%s', (_name, view, state, errorKind) => {
    const page = transcriptPageOf(view)
    expect(page.state).toBe(state)
    expect(page.error?.kind ?? null).toBe(errorKind)
  })
})

describe('backTarget', () => {
  const item: BoardItemRef = { repoId: REPO, number: 7 }

  it.each([
    ['search', { to: 'search' }],
    ['board', { to: 'board', item }],
    ['pipeline', { to: 'board', item }],
    ['history', { to: 'history' }],
  ] as const)('%s', (from, expected) => {
    expect(backTarget(from, item)).toEqual(expected)
  })
})

describe('ticketOf', () => {
  const item = reconciledItem({ number: 7 })
  const snapshot = boardSnapshot([repositoryState([item])])
  const failed: RepositoryState = { ok: false, repoId: REPO, displayName: 'o/a', reason: 'not-ready', problem: { kind: 'not-a-git-repository' } }

  it.each([
    ['a found ticket', snapshot, REPO, 7, item],
    ['a missing number', snapshot, REPO, 8, null],
    ['a missing repository', snapshot, 'repo-z' as RepoId, 7, null],
    ['a failed repository', boardSnapshot([failed]), REPO, 7, null],
    ['no snapshot yet', undefined, REPO, 7, null],
  ])('%s', (_name, source, repoId, number, expected) => {
    expect(ticketOf(source, repoId, number)).toBe(expected)
  })
})
