// Pure decisions behind the Repositories screen and its list tab — no React, no data hooks.
import type { PageStateKind } from '@/renderer/components/page-state'
import { inspectDenials } from '@/renderer/local/inspect'
import { registryBannerCopy } from '@/renderer/repositories/copy'
import type { RegistryErrorReason } from '@/renderer/repositories/copy'
import type { BoardSnapshot } from '@/types/board'
import type { RegistryFailureKind, ReposAddResponse, ReposListResponse, ReposRemoveResponse } from '@/types/ipc'
import type { ActionToast } from '@/types/toast'
import type { RepoId, RepositoryEntry } from '@/utils/repos'

type DenialInspection = ReturnType<typeof inspectDenials>

interface ListQuery {
  readonly data: ReposListResponse | undefined
  readonly status: 'pending' | 'error' | 'success'
}

interface RepoLookup {
  readonly state: PageStateKind
  readonly entry: RepositoryEntry | null
  readonly failure: RegistryFailureKind | null
}

export function repoName(entry: RepositoryEntry): string {
  return 'config' in entry ? entry.config.repo : entry.displayName
}

/** Stale data stays on screen, a typed registry failure is data the view renders, and only a rejected read with nothing in hand is `error`. */
export function repoLookup(query: ListQuery, repoId: string): RepoLookup {
  if (query.data === undefined) return { state: query.status === 'error' ? 'error' : 'loading', entry: null, failure: null }
  if (!query.data.ok) return { state: 'ready', entry: null, failure: query.data.kind }
  const entry = query.data.repositories.find((repository) => repository.id === repoId) ?? null
  return { state: entry === null ? 'empty' : 'ready', entry, failure: null }
}

export function registryReason(kind: RegistryFailureKind): RegistryErrorReason {
  if (kind === 'registry-malformed') return 'malformed'
  if (kind === 'registry-unsupported-version') return 'unsupported-version'
  return 'unreadable'
}

export function registryFailureCopy(kind: RegistryFailureKind): string {
  return registryBannerCopy({ path: 'registry.json', reason: registryReason(kind) })
}

function toast(tone: ActionToast['tone'], title: string): ActionToast {
  return { tone, title, description: null, action: null, cancel: null }
}

export function addResultToast(result: ReposAddResponse): ActionToast | null {
  if (!result.ok) return toast('error', `Couldn't add the repository: ${result.message}`)
  if (result.outcome === 'cancelled') return null
  if (result.outcome === 'already-registered') return toast('info', 'Already added.')
  const added = result.repositories.find((repository) => repository.id === result.added)
  return toast('success', `Added ${added === undefined ? result.added : repoName(added)}.`)
}

export function removeResultToast(name: string, result: ReposRemoveResponse): ActionToast {
  return result.ok ? toast('success', `Removed ${name}.`) : toast('error', `Couldn't remove ${name}: ${result.message}`)
}

/** `null` when the repository isn't in the snapshot, or its state couldn't be read. */
export function denialsRegion(snapshot: BoardSnapshot, repoId: RepoId): DenialInspection | null {
  const repo = snapshot.state.repositories.find((r) => r.ok && r.repoId === repoId)
  if (repo === undefined || !repo.ok) return null
  return inspectDenials({ read: repo.denials, sessions: snapshot.state.sessions })
}

/** A failed read is not empty: it renders its own banner. */
export function isDenialsEmpty(inspection: DenialInspection | null): boolean {
  if (inspection === null) return true
  if (!inspection.ok) return false
  return !inspection.present || inspection.analysed === 0
}
