// readPipelineState — the cross-repo I/O orchestrator (#79). It composes
// #74's registry, #76's GitHub reader, #77's local reader, and #78's session
// reader, and adds nothing they already own: no config read, no second `gh`
// caller, no worktree enumeration, no transcript parsing. Every seam is
// injectable, so `read.test.ts` needs no `gh`, no `git`, and no Agent SDK.
import { fetchItemsByNumber, fetchPipelineItems } from '../github'
import type { GhRunner } from '../github'
import { readDenials, readWorktrees } from '../local'
import type { WorktreesGitRunner as GitRunner } from '../local'
import { readSessionState } from '../sessions'
import type { RepositoryEntry } from '../../shared/repos'
import type { ItemsByNumberFetch } from '../../shared/github/types'
import type { FreshnessEntry, PipelineState, RepositoryState } from '../../shared/state/types'
import { collectOrphanNumbers } from './attach'
import { reconcileRepository } from './reconcile'
import type { RepoSessionSlice } from './reconcile'

export interface ReadPipelineStateParams {
  readonly repositories: readonly RepositoryEntry[]
  readonly gh?: GhRunner
  readonly git?: GitRunner
  readonly sessionReader?: Parameters<typeof readSessionState>[0]['reader']
  /** Forwarded verbatim to `readSessionState` — the seam its own tests use
   *  to point at a temporary `~/.claude` fixture, needed here too so
   *  `read.test.ts` can attribute a fake session without touching the real
   *  machine's transcripts. */
  readonly claudeHome?: string
  readonly now?: () => Date
}

function isReady(entry: RepositoryEntry): entry is Extract<RepositoryEntry, { status: 'ready' }> {
  return 'status' in entry && entry.status === 'ready'
}

function splitRepo(repo: string): { readonly owner: string; readonly name: string } {
  const [owner, name] = repo.split('/')
  return { owner: owner ?? '', name: name ?? '' }
}

/**
 * One `readSessionState` call for the whole machine first (#78's own
 * Decision 1), then per `ready` repository: `fetchPipelineItems`,
 * `collectOrphanNumbers`, one conditional `fetchItemsByNumber`,
 * `readWorktrees`, `readDenials` — then `reconcileRepository` with that
 * repository's own session slice. A non-`ready` entry becomes its
 * `reason: 'not-ready'` state without any read at all.
 */
export async function readPipelineState(params: ReadPipelineStateParams): Promise<PipelineState> {
  const now = params.now ?? (() => new Date())
  const readAt = now().toISOString()

  const readyEntries = params.repositories.filter(isReady)
  const sessionScan = await readSessionState({
    repos: readyEntries.map((entry) => ({ id: entry.id, root: entry.path })),
    reader: params.sessionReader,
    claudeHome: params.claudeHome,
    now,
  })
  const sessionsFreshness: FreshnessEntry = sessionScan.ok ? { at: sessionScan.scannedAt } : { unavailable: sessionScan.message }

  const repositories: RepositoryState[] = []
  for (const entry of params.repositories) {
    if (!isReady(entry)) {
      repositories.push({ ok: false, repoId: entry.id, displayName: entry.displayName, reason: 'not-ready', problem: entry.problem })
      continue
    }

    const repo = splitRepo(entry.config.repo)
    const pipelineFetch = await fetchPipelineItems({ repo, vocabulary: entry.config.vocabulary, gh: params.gh, now })
    const worktrees = await readWorktrees({ repoRoot: entry.path, git: params.git, now })
    const denials = await readDenials({ repoRoot: entry.path, git: params.git, now })

    const repoAgents = sessionScan.ok ? sessionScan.agents.filter((a) => a.repoId === entry.id) : []
    const repoSessionRecords = sessionScan.ok ? sessionScan.sessions.filter((s) => s.repoId === entry.id) : []
    const repoSessions: RepoSessionSlice = { agents: repoAgents, sessions: repoSessionRecords, available: sessionScan.ok, freshness: sessionsFreshness }

    let itemsByNumberFetch: ItemsByNumberFetch | null = null
    if (pipelineFetch.ok) {
      const worktreeEntries = worktrees.ok ? worktrees.entries : []
      const orphanNumbers = collectOrphanNumbers(pipelineFetch.items, worktreeEntries, repoAgents)
      if (orphanNumbers.length > 0) {
        itemsByNumberFetch = await fetchItemsByNumber({ repo, numbers: orphanNumbers, gh: params.gh, now })
      }
    }

    repositories.push(reconcileRepository({ entry, pipelineFetch, itemsByNumberFetch, repoSessions, worktrees, denials }))
  }

  return { repositories, sessions: sessionScan, readAt }
}
