// Pure page state, back target and ticket lookup for the Transcript screen — no DOM, no IPC.
import type { BoardSnapshot } from '@/types/board'
import type { BoardItemRef, TranscriptSearch } from '@/types/router'
import type { ReconciledItem } from '@/types/state'
import type { PageStateKind } from '@/renderer/components/page-state'
import type { FileTranscript } from '@/renderer/data/transcript-model'
import type { RepoId } from '@/utils/repos'

type OpenFailure = Extract<FileTranscript, { status: 'open-failed' }>['failure']

export type TranscriptError = { readonly kind: 'unreachable' } | { readonly kind: 'open'; readonly failure: OpenFailure }

type TranscriptView = { readonly status: 'loading' } | { readonly status: 'unreachable' } | FileTranscript

interface TranscriptPage {
  readonly state: PageStateKind
  readonly error: TranscriptError | null
}

export function transcriptPageOf(view: TranscriptView): TranscriptPage {
  switch (view.status) {
    case 'loading':
      return { state: 'loading', error: null }
    case 'unreachable':
      return { state: 'error', error: { kind: 'unreachable' } }
    case 'open-failed':
      return { state: 'error', error: { kind: 'open', failure: view.failure } }
    case 'ready':
      return { state: view.entries.length === 0 ? 'empty' : 'ready', error: null }
  }
}

type BackTarget = { readonly to: 'search' } | { readonly to: 'board'; readonly item: BoardItemRef | null } | { readonly to: 'history' }

export function backTarget(from: TranscriptSearch['from'], item: BoardItemRef | null): BackTarget {
  if (from === 'search') return { to: 'search' }
  if (from === 'board' || from === 'pipeline') return { to: 'board', item }
  return { to: 'history' }
}

/** `null` when the board has not loaded, the repository failed to read, or the ticket is gone. */
export function ticketOf(snapshot: BoardSnapshot | undefined, repoId: RepoId, number: number): ReconciledItem | null {
  const repoState = snapshot?.state.repositories.find((candidate) => candidate.repoId === repoId)
  if (repoState === undefined || !repoState.ok) return null
  return repoState.items.find((candidate) => candidate.number === number) ?? null
}
