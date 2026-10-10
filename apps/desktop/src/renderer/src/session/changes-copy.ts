// Pure copy for the Changes pane — no React import, so every string is
// unit-testable directly. `changesErrorCopy` is exhaustive over
// `SessionChangesFailureKind` plus `'unreachable'` (the query itself
// rejected, distinct from a typed `{ ok: false }` response).
import type { SessionChangesFailureKind } from '../../../shared/workspace/types'

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export interface ChangesHeader {
  readonly prefix: string
  readonly branch: string | null
  readonly sha: string
}

/** A worktree session reads "Changes since `<branch>` base · <sha>"; a
 *  non-worktree session reads "Changes since <sha>". */
export function changesHeader(base: { readonly sha: string }, worktreeBranch: string | null): ChangesHeader {
  return { prefix: 'Changes since', branch: worktreeBranch, sha: shortSha(base.sha) }
}

export function changesHeaderText(base: { readonly sha: string }, worktreeBranch: string | null): string {
  const header = changesHeader(base, worktreeBranch)
  return header.branch !== null ? `Changes since ${header.branch} base · ${header.sha}` : `Changes since ${header.sha}`
}

export function changesEmpty(sha: string): string {
  return `No changes since ${shortSha(sha)}.`
}

export function changesTooLarge(count: number): string {
  return `This diff is too large to show here. ${String(count)} file${count === 1 ? '' : 's'} changed.`
}

export function untrackedLine(path: string): string {
  return `New, not yet added: ${path}`
}

export function binaryLine(path: string): string {
  return `${path} · binary`
}

export interface NumstatLine {
  readonly added: string
  readonly removed: string
}

export function numstatLine({ additions, deletions }: { readonly additions: number; readonly deletions: number }): NumstatLine {
  return { added: `+${String(additions)}`, removed: `−${String(deletions)}` }
}

export const REFRESH_CHANGES = 'Refresh changes'
export const CLOSE_CHANGES = 'Close changes'

/** Every `SessionChangesFailureKind` plus `'unreachable'` (the query
 *  rejected rather than returning a typed failure). `unknown-session` and
 *  `not-git` are reachable only through a race, since the Changes button is
 *  gated on `workspace.root !== null`. */
export function changesErrorCopy(failure: { readonly kind: SessionChangesFailureKind; readonly message: string } | 'unreachable', baseSha: string | null): string {
  if (failure === 'unreachable') return 'Could not reach the main process.'
  switch (failure.kind) {
    case 'base-missing':
      return baseSha !== null ? `The base commit ${shortSha(baseSha)} is gone from this repository.` : 'The base commit is gone from this repository.'
    case 'folder-missing':
      return "This session's folder no longer exists."
    case 'git-failed':
      return `git couldn't compute the diff: ${failure.message}`
    case 'unknown-session':
      return 'This session is no longer open.'
    case 'not-git':
      return "This session's folder isn't a git repository."
  }
}
