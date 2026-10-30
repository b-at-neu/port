// The only "new item" diff: which visible Needs you items were absent from the last read.
import type { BoardSnapshot, NeedsYouBaseline, NeedsYouItem } from '@/types/board'
import type { IpcMap } from '@/types/ipc'
import type { RepoId } from '@/utils/repos'
import { dismissKeyOf } from '@/renderer/needs-you/dismiss-key'
import { needsYouLeadCopy } from '@/renderer/needs-you/copy'

interface NeedsYouDiff {
  readonly baseline: NeedsYouBaseline
  readonly fresh: readonly NeedsYouItem[]
}

type NeedsYouNotification = IpcMap['notify:needs-you']['request']

const MAX_TEXT = 200

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`
}

/** Repositories this read actually answered for; every other repository's items are unknown, not gone. */
export function readableRepoIds(snapshot: BoardSnapshot): ReadonlySet<RepoId> {
  return new Set(snapshot.state.repositories.filter((repo) => repo.ok).map((repo) => repo.repoId))
}

export function displayNamesOf(snapshot: BoardSnapshot): ReadonlyMap<RepoId, string> {
  return new Map(snapshot.state.repositories.map((repo) => [repo.repoId, repo.displayName]))
}

/** `previous === null` is a silent seed. A repository this read could not answer for keeps its previous keys, so a blind read never clears them and recovery never re-notifies. */
export function diffNeedsYou(previous: NeedsYouBaseline | null, items: readonly NeedsYouItem[], readable: ReadonlySet<RepoId>): NeedsYouDiff {
  const current: Record<string, string[]> = {}
  for (const item of items) (current[item.repoId ?? ''] ??= []).push(dismissKeyOf(item))

  if (previous === null) return { baseline: current, fresh: [] }

  const known = new Set(Object.values(previous).flat())
  const fresh = items.filter((item) => !known.has(dismissKeyOf(item)))

  const baseline: Record<string, readonly string[]> = { ...current }
  for (const [repoId, keys] of Object.entries(previous)) {
    if (repoId === '' || readable.has(repoId as RepoId)) continue
    baseline[repoId] = [...new Set([...(baseline[repoId] ?? []), ...keys])]
  }
  return { baseline, fresh }
}

function titleOf(item: NeedsYouItem, displayNames: ReadonlyMap<RepoId, string>): string {
  const repo = item.repoId !== null ? displayNames.get(item.repoId) : undefined
  const ref = item.ticket
  const ticket = ref !== null ? `${ref.kind === 'issue' ? '#' : 'PR#'}${String(ref.number)}${ref.title === '' ? '' : ` ${ref.title}`}` : item.number !== null ? `#${String(item.number)}` : null
  return [repo, ticket].filter((part): part is string => part !== undefined && part !== null).join(' · ')
}

export function needsYouNotification(fresh: readonly NeedsYouItem[], displayNames: ReadonlyMap<RepoId, string>): NeedsYouNotification | null {
  const [only, ...rest] = fresh
  if (only === undefined) return null
  if (rest.length > 0) return { title: 'port', body: `${String(fresh.length)} new items need you`, focus: null }
  return { title: clip(titleOf(only, displayNames) || 'port'), body: clip(needsYouLeadCopy(only)), focus: dismissKeyOf(only) }
}
