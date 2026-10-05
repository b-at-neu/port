// The pure "Needs you" derivation — the sidebar count and the dedicated
// screen both consume it unchanged. No import here may reach a Node
// builtin or src/main/.
import type { RepoId } from '../repos'
import type { RepositoryState } from '../state/types'
import { stageLabelOf } from './project'
import type { BoardSnapshot } from './types'

export type NeedsYouReason = 'plan-review' | 'ready-to-merge' | 'needs-human' | 'blocked' | 'question'

// Every other stage key carries no "needs you" reason at all.
const STAGE_REASONS: Readonly<Partial<Record<string, NeedsYouReason>>> = {
  planReview: 'plan-review',
  approved: 'ready-to-merge',
  needsHuman: 'needs-human',
  blocked: 'blocked',
}

// title/url are null only for a question reason matching no board row.
export interface NeedsYouItem {
  readonly repoId: RepoId | null
  readonly repo: string | null
  readonly number: number | null
  readonly title: string | null
  readonly url: string | null
  readonly reasons: readonly NeedsYouReason[]
}

interface MutableItem {
  repo: string | null
  title: string | null
  url: string | null
  reasons: NeedsYouReason[]
}

function addReason(byKey: Map<string, MutableItem>, key: string, reason: NeedsYouReason, base: { readonly repo: string | null; readonly title: string | null; readonly url: string | null }): void {
  const existing = byKey.get(key)
  if (existing) {
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason)
    return
  }
  byKey.set(key, { repo: base.repo, title: base.title, url: base.url, reasons: [reason] })
}

// One entry per (repoId, number). A null viewer includes the item anyway.
export function needsYouItems(snapshot: BoardSnapshot): readonly NeedsYouItem[] {
  const byKey = new Map<string, MutableItem>()
  const keyOf = new Map<string, { readonly repoId: RepoId | null; readonly number: number | null }>()

  const readyRepos = snapshot.state.repositories.filter((r): r is Extract<RepositoryState, { readonly ok: true }> => r.ok)
  for (const repo of readyRepos) {
    for (const item of repo.items) {
      const reason = STAGE_REASONS[stageLabelOf(item)?.key ?? '']
      if (reason === undefined) continue
      if (repo.viewer !== null && !item.assignees.includes(repo.viewer)) continue
      const key = `${item.repoId}:${String(item.number)}`
      addReason(byKey, key, reason, { repo: item.repo, title: item.title, url: item.url })
      keyOf.set(key, { repoId: item.repoId, number: item.number })
    }
  }

  if (snapshot.relay.ok) {
    for (const pending of snapshot.relay.pending) {
      const key = pending.repoId !== null && pending.number !== null ? `${pending.repoId}:${String(pending.number)}` : `relay:${pending.sessionId}:${pending.agentId ?? ''}`
      addReason(byKey, key, 'question', { repo: null, title: null, url: null })
      if (!keyOf.has(key)) keyOf.set(key, { repoId: pending.repoId, number: pending.number })
    }
  }

  const items: NeedsYouItem[] = []
  for (const [key, entry] of byKey) {
    const identity = keyOf.get(key) ?? { repoId: null, number: null }
    items.push({ repoId: identity.repoId, repo: entry.repo, number: identity.number, title: entry.title, url: entry.url, reasons: entry.reasons })
  }
  return items
}

export function needsYouCount(items: readonly NeedsYouItem[]): number {
  return items.length
}

export function repoNeedsYou(items: readonly NeedsYouItem[], repoId: RepoId): number {
  return items.filter((item) => item.repoId === repoId).length
}
